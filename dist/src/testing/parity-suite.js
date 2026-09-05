import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
const PARITY_SUITE_SCHEMA_VERSION = "chatgpt.browser_control.parity_suite.v1";
export function validateParitySuite(packageRootInput = defaultPackageRoot()) {
    const packageRoot = toPath(packageRootInput);
    const repoLayout = resolveRepoLayout(packageRoot);
    const contractRoot = join(packageRoot, "contracts", "v1");
    const matrixPath = join(contractRoot, "parity-suite.json");
    const manifestPath = join(contractRoot, "manifest.json");
    const matrix = readJson(matrixPath);
    const manifest = readJson(manifestPath);
    const errors = [];
    if (matrix.schemaVersion !== PARITY_SUITE_SCHEMA_VERSION) {
        errors.push(`parity-suite.json has unsupported schemaVersion ${String(matrix.schemaVersion)}.`);
    }
    const surfaceIds = new Set(matrix.surfaces.map(surface => surface.id));
    if (surfaceIds.size !== matrix.surfaces.length) {
        errors.push("parity-suite.json contains duplicate surface ids.");
    }
    const manifestFixtures = sortedUnique(manifest.fixtures.map(fixture => fixture.file));
    const sourceCommands = readBackendCommands(join(packageRoot, "src", "backend", "protocol.ts"));
    const coveredFixtures = sortedUnique([
        ...matrix.surfaces.flatMap(surface => surface.fixtures ?? []),
        ...Object.values(matrix.backendCommands).flatMap(command => command.fixtures ?? [])
    ]);
    const coveredCommands = sortedUnique(Object.keys(matrix.backendCommands));
    compareSets("fixture coverage", coveredFixtures, manifestFixtures, errors);
    compareSets("backend command coverage", coveredCommands, sourceCommands, errors);
    validateSurfaces(matrix.surfaces, surfaceIds, manifestFixtures, packageRoot, repoLayout, errors);
    validateCommands(matrix.backendCommands, surfaceIds, manifestFixtures, packageRoot, repoLayout, errors);
    validateGates(matrix.gates, packageRoot, repoLayout, errors);
    if (errors.length > 0) {
        throw new Error(`Parity suite validation failed:\n- ${errors.join("\n- ")}`);
    }
    return {
        evidenceMode: repoLayout.fullRepo ? "full-repo" : "package-local",
        surfaceCount: matrix.surfaces.length,
        fixtureCount: manifestFixtures.length,
        commandCount: sourceCommands.length,
        gateCount: matrix.gates.length,
        manifestFixtures,
        coveredFixtures,
        sourceCommands,
        coveredCommands
    };
}
function validateSurfaces(surfaces, surfaceIds, manifestFixtures, packageRoot, repoLayout, errors) {
    for (const surface of surfaces) {
        const label = `surface ${surface.id}`;
        if (surface.summary.length === 0)
            errors.push(`${label} must include a summary.`);
        validateEvidence(label, surface, surfaceIds, manifestFixtures, packageRoot, repoLayout, errors);
    }
}
function validateCommands(commands, surfaceIds, manifestFixtures, packageRoot, repoLayout, errors) {
    for (const [command, coverage] of Object.entries(commands)) {
        const label = `backend command ${command}`;
        if (!surfaceIds.has(coverage.surface)) {
            errors.push(`${label} references unknown surface ${coverage.surface}.`);
        }
        validateEvidence(label, coverage, surfaceIds, manifestFixtures, packageRoot, repoLayout, errors);
        if ((coverage.nodeTests ?? []).length === 0)
            errors.push(`${label} must include nodeTests evidence.`);
        if ((coverage.pythonTests ?? []).length === 0)
            errors.push(`${label} must include pythonTests evidence.`);
        if ((coverage.docs ?? []).length === 0)
            errors.push(`${label} must include docs evidence.`);
    }
}
function validateEvidence(label, evidence, _surfaceIds, manifestFixtures, packageRoot, repoLayout, errors) {
    for (const fixture of evidence.fixtures ?? []) {
        if (!manifestFixtures.includes(fixture)) {
            errors.push(`${label} references unknown fixture ${fixture}.`);
        }
        assertExists(`${label} fixture ${fixture}`, join(packageRoot, "contracts", "v1", "fixtures", fixture), errors);
    }
    for (const sourceFile of evidence.sourceFiles ?? []) {
        assertExists(`${label} source ${sourceFile}`, join(packageRoot, sourceFile), errors);
    }
    for (const nodeTest of evidence.nodeTests ?? []) {
        assertExists(`${label} node test ${nodeTest}`, join(packageRoot, nodeTest), errors);
    }
    for (const pythonTest of evidence.pythonTests ?? []) {
        if (repoLayout.pythonRoot !== undefined) {
            assertExists(`${label} python test ${pythonTest}`, join(repoLayout.pythonRoot, pythonTest), errors);
        }
    }
    for (const doc of evidence.docs ?? []) {
        if (!existsAtAny([join(packageRoot, doc), join(repoLayout.repoRoot, doc)])) {
            if (!repoLayout.fullRepo && doc.startsWith("../")) {
                continue;
            }
            errors.push(`${label} docs ${doc} does not exist.`);
        }
    }
}
function validateGates(gates, packageRoot, repoLayout, errors) {
    const ids = new Set();
    const packageJson = readJson(join(packageRoot, "package.json"));
    const workflowText = repoLayout.fullRepo ? readWorkflowText(join(repoLayout.repoRoot, ".github", "workflows")) : "";
    for (const gate of gates) {
        if (ids.has(gate.id))
            errors.push(`gate ${gate.id} is duplicated.`);
        ids.add(gate.id);
        if (repoLayout.fullRepo) {
            assertExists(`gate ${gate.id} cwd ${gate.cwd}`, join(repoLayout.repoRoot, gate.cwd), errors);
        }
        const script = npmRunScriptName(gate.command);
        if (script !== undefined && packageJson.scripts?.[script] === undefined) {
            errors.push(`gate ${gate.id} references missing npm script ${script}.`);
        }
        if (repoLayout.fullRepo && gate.ciRequired !== false && !workflowText.includes(gate.command)) {
            errors.push(`gate ${gate.id} command is missing from chatgpt-sdk-parity.yml: ${gate.command}`);
        }
    }
}
function readWorkflowText(workflowsDir) {
    if (!existsSync(workflowsDir))
        return "";
    return readdirSync(workflowsDir)
        .filter(file => /\.(ya?ml)$/i.test(file))
        .map(file => readFileSync(join(workflowsDir, file), "utf8"))
        .join("\n");
}
function resolveRepoLayout(packageRoot) {
    const repoRoot = resolve(packageRoot, "..", "..");
    const packageFromRepoRoot = join(repoRoot, "packages", "node");
    const pythonFromRepoRoot = join(repoRoot, "packages", "python");
    if (existsSync(packageFromRepoRoot) && existsSync(pythonFromRepoRoot)) {
        return { repoRoot, pythonRoot: pythonFromRepoRoot, fullRepo: true };
    }
    const siblingPythonRoot = resolve(packageRoot, "..", "python");
    if (existsSync(siblingPythonRoot)) {
        return { repoRoot, pythonRoot: siblingPythonRoot, fullRepo: false };
    }
    return { repoRoot, fullRepo: false };
}
function readBackendCommands(protocolPath) {
    const sourceText = readFileSync(protocolPath, "utf8");
    const sourceFile = ts.createSourceFile(protocolPath, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const commands = [];
    function visit(node) {
        if (ts.isVariableStatement(node)) {
            for (const declaration of node.declarationList.declarations) {
                if (ts.isIdentifier(declaration.name)
                    && declaration.name.text === "backendCommands"
                    && declaration.initializer !== undefined) {
                    const array = unwrapConstAssertion(declaration.initializer);
                    if (!ts.isArrayLiteralExpression(array)) {
                        throw new Error("backendCommands must be declared as an array literal.");
                    }
                    for (const element of array.elements) {
                        if (!ts.isStringLiteral(element)) {
                            throw new Error("backendCommands may only contain string literals.");
                        }
                        commands.push(element.text);
                    }
                }
            }
        }
        ts.forEachChild(node, visit);
    }
    visit(sourceFile);
    if (commands.length === 0)
        throw new Error("Unable to find backendCommands in backend protocol source.");
    return sortedUnique(commands);
}
function unwrapConstAssertion(node) {
    if (ts.isAsExpression(node))
        return unwrapConstAssertion(node.expression);
    return node;
}
function compareSets(label, actual, expected, errors) {
    const actualSet = new Set(actual);
    const expectedSet = new Set(expected);
    const missing = expected.filter(item => !actualSet.has(item));
    const extra = actual.filter(item => !expectedSet.has(item));
    if (missing.length > 0)
        errors.push(`${label} missing: ${missing.join(", ")}`);
    if (extra.length > 0)
        errors.push(`${label} extra: ${extra.join(", ")}`);
}
function assertExists(label, path, errors) {
    if (!existsSync(path))
        errors.push(`${label} does not exist at ${path}.`);
}
function existsAtAny(paths) {
    return paths.some(path => existsSync(path));
}
function npmRunScriptName(command) {
    const match = command.match(/^npm run ([^\s]+)$/);
    if (match !== null)
        return match[1];
    if (command === "npm test")
        return "test";
    return undefined;
}
function sortedUnique(values) {
    return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}
function readJson(path) {
    return JSON.parse(readFileSync(path, "utf8"));
}
function toPath(input) {
    if (input instanceof URL)
        return fileURLToPath(input);
    return input;
}
function defaultPackageRoot() {
    return resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
}
