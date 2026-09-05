import { canonicalJson } from "./canonical.js";
/**
 * The turn ownership classifier deliberately accepts normalized, already
 * redacted observations.  It must never be handed DOM nodes or prompt text.
 * Adapters are responsible for producing the bounded digests in these types.
 */
export const TURN_OWNERSHIP_SCHEMA_VERSION = "chatgpt.browser_control.turn_ownership.v1";
const MAX_IDENTIFIER_LENGTH = 512;
const MAX_DIGEST_LENGTH = 512;
const MAX_TURNS = 256;
const MAX_ARTIFACTS_PER_TURN = 32;
const DIGEST_PATTERN = /^[a-z][a-z0-9-]{1,31}:[A-Za-z0-9_-]{16,512}$/;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9._:-]{1,512}$/;
/**
 * Classify one normalized snapshot.  This function has no browser, DOM, or
 * I/O dependency.  It only permits an owned user turn when the adapter has
 * supplied the exact post-Send delta digest and operation-specific evidence.
 */
export function classifyTurnOwnership(input) {
    validateInput(input);
    const { binding, baseline, snapshot, submissionWitness, prior } = input;
    const target = compareBindingToBaselineTarget(binding, baseline, submissionWitness);
    if (target.status === "mismatch" || target.status === "replacement") {
        return result(input, "target_mismatch", "baseline_target_mismatch", target, undefined, undefined, undefined, 0, 0);
    }
    if (target.status === "unavailable") {
        return result(input, "target_evidence_unavailable", "target_evidence_unavailable", target, undefined, undefined, undefined, 0, 0);
    }
    const freshTarget = compareBindingToTarget(binding, snapshot.target);
    if (freshTarget.status === "mismatch") {
        return result(input, "target_mismatch", "target_binding_mismatch", freshTarget, undefined, undefined, undefined, 0, 0);
    }
    if (freshTarget.status === "unavailable") {
        return result(input, "target_evidence_unavailable", "target_evidence_unavailable", freshTarget, undefined, undefined, undefined, 0, 0);
    }
    if (snapshot.completeness !== "complete") {
        const reason = snapshot.completeness === "out_of_order"
            ? "out_of_order_snapshot"
            : "incomplete_snapshot";
        return result(input, "ownership_ambiguous", reason, freshTarget, undefined, undefined, undefined, 0, 0);
    }
    const users = analyzeDelta(baseline.userTurns, snapshot.userTurns);
    const assistants = analyzeDelta(baseline.assistantTurns, snapshot.assistantTurns);
    if (!users.valid) {
        return result(input, "ownership_ambiguous", users.reason ?? "baseline_turn_missing", freshTarget, undefined, undefined, undefined, users.added.length, assistants.added.length);
    }
    if (!assistants.valid) {
        return result(input, "ownership_ambiguous", assistants.reason ?? "baseline_turn_missing", freshTarget, undefined, undefined, undefined, users.added.length, assistants.added.length);
    }
    if (prior !== undefined) {
        return classifyWithPrior(input, freshTarget, users, assistants, prior);
    }
    if (freshTarget.status === "replacement") {
        // A replacement tab is never trusted merely because it has the same URL.
        // The exact operation-owned user evidence below is the recovery anchor.
        if (users.added.length === 0) {
            return result(input, "target_mismatch", "replacement_tab_requires_owned_user", freshTarget, undefined, undefined, undefined, users.added.length, assistants.added.length);
        }
    }
    if (users.intervening) {
        return result(input, "concurrent_user_turn", "intervening_user_turn", freshTarget, users.added[0], undefined, undefined, users.added.length, assistants.added.length);
    }
    if (users.added.length === 0) {
        if (snapshot.postSendDelta !== undefined
            && (snapshot.postSendDelta.baselineSnapshotDigest !== baseline.snapshotDigest
                || snapshot.postSendDelta.addedUserEvidenceDigests.length !== 0)) {
            return result(input, "ownership_ambiguous", "post_send_delta_mismatch", freshTarget, undefined, assistants.added[0], undefined, 0, assistants.added.length);
        }
        if (assistants.added.length > 0) {
            return result(input, "ownership_ambiguous", "unexpected_new_assistant_turn", freshTarget, undefined, assistants.added[0], undefined, 0, assistants.added.length);
        }
        return result(input, "no_operation_turn", "none", freshTarget, undefined, undefined, undefined, 0, 0);
    }
    if (users.added.length > 1) {
        return result(input, "concurrent_user_turn", "multiple_new_user_turns", freshTarget, users.added[0], undefined, undefined, users.added.length, assistants.added.length);
    }
    const user = users.added[0];
    if (user === undefined) {
        return result(input, "ownership_ambiguous", "stable_user_turn_id_unavailable", freshTarget, undefined, undefined, undefined, 0, assistants.added.length);
    }
    const proof = proveSubmittedUser(input, user);
    if (!proof.ok) {
        return result(input, proof.status, proof.reason, freshTarget, user, assistants.added[0], undefined, users.added.length, assistants.added.length);
    }
    return classifyFreshOwnedUser(input, freshTarget, user, assistants);
}
/** Return the deterministic, redacted JSON input a caller may HMAC. */
export function ownershipEvidenceJson(material) {
    return canonicalJson(material);
}
/** Validate a cursor before persisting or supplying it to a later snapshot. */
export function validateOwnershipCursor(cursor) {
    if (!isRecord(cursor))
        throw new TypeError("Ownership cursor must be an object.");
    assertExactKeys(cursor, "cursor", ["schemaVersion", "operationId", "targetBindingDigest", "phase", "userTurnId", "userTurnEvidenceDigest", "assistantTurnId", "assistantBranchId", "snapshotDigest", "assistantEvidenceDigest", "assistantStructureDigest"], ["schemaVersion", "operationId", "targetBindingDigest", "phase", "userTurnId", "userTurnEvidenceDigest", "snapshotDigest"]);
    if (cursor.schemaVersion !== TURN_OWNERSHIP_SCHEMA_VERSION)
        throw new TypeError("Unsupported ownership cursor schema version.");
    if (cursor.phase !== "owned_user_turn" && cursor.phase !== "owned_assistant_generating" && cursor.phase !== "owned_assistant_terminal") {
        throw new TypeError("Ownership cursor phase is invalid.");
    }
    assertIdentifier(cursor.operationId, "cursor.operationId");
    assertDigest(cursor.targetBindingDigest, "cursor.targetBindingDigest");
    assertIdentifier(cursor.userTurnId, "cursor.userTurnId");
    assertDigest(cursor.userTurnEvidenceDigest, "cursor.userTurnEvidenceDigest");
    assertDigest(cursor.snapshotDigest, "cursor.snapshotDigest");
    if (cursor.phase === "owned_user_turn") {
        if (cursor.assistantTurnId !== undefined || cursor.assistantBranchId !== undefined
            || cursor.assistantEvidenceDigest !== undefined || cursor.assistantStructureDigest !== undefined) {
            throw new TypeError("User-turn cursor cannot contain assistant identity.");
        }
    }
    else {
        if (cursor.assistantTurnId === undefined || cursor.assistantBranchId === undefined
            || cursor.assistantEvidenceDigest === undefined || cursor.assistantStructureDigest === undefined) {
            throw new TypeError("Assistant cursor requires stable assistant, branch, and evidence identities.");
        }
        assertIdentifier(cursor.assistantTurnId, "cursor.assistantTurnId");
        assertIdentifier(cursor.assistantBranchId, "cursor.assistantBranchId");
        assertDigest(cursor.assistantEvidenceDigest, "cursor.assistantEvidenceDigest");
        assertDigest(cursor.assistantStructureDigest, "cursor.assistantStructureDigest");
    }
}
function classifyWithPrior(input, target, users, assistants, prior) {
    const { binding, snapshot } = input;
    if (prior.operationId !== binding.operationId || prior.targetBindingDigest !== binding.targetBindingDigest) {
        return result(input, "ownership_ambiguous", "prior_cursor_mismatch", target, undefined, undefined, undefined, users.added.length, assistants.added.length);
    }
    const user = snapshot.userTurns.find(turn => turn.stableId === prior.userTurnId);
    if (user === undefined) {
        return result(input, "ownership_ambiguous", "prior_owned_turn_missing", target, undefined, undefined, undefined, users.added.length, assistants.added.length);
    }
    if (user.evidenceDigest !== prior.userTurnEvidenceDigest) {
        return result(input, "ownership_ambiguous", "prior_owned_turn_changed", target, user, undefined, undefined, users.added.length, assistants.added.length);
    }
    if (users.added.length !== 1 || users.added[0]?.stableId !== prior.userTurnId) {
        return result(input, "concurrent_user_turn", "multiple_new_user_turns", target, user, undefined, undefined, users.added.length, assistants.added.length);
    }
    if (target.status === "replacement" && !hasStableConversationAndClaim(binding, snapshot)) {
        return result(input, "target_evidence_unavailable", "target_evidence_unavailable", target, user, undefined, undefined, users.added.length, assistants.added.length);
    }
    const ownedAssistant = snapshot.assistantTurns.find(turn => turn.stableId === prior.assistantTurnId);
    if (prior.phase !== "owned_user_turn") {
        if (ownedAssistant === undefined) {
            return result(input, "ownership_ambiguous", "prior_owned_turn_missing", target, user, undefined, undefined, users.added.length, assistants.added.length);
        }
        const unexpected = assistants.added.filter(turn => turn.stableId !== prior.assistantTurnId);
        if (unexpected.length > 0) {
            return result(input, "regeneration_ambiguous", "regeneration_siblings", target, user, unexpected[0], undefined, users.added.length, assistants.added.length);
        }
        if (ownedAssistant.parentStableId !== user.stableId || ownedAssistant.branchStableId !== prior.assistantBranchId) {
            return result(input, "ownership_ambiguous", "stable_parent_identity_unavailable", target, user, ownedAssistant, undefined, users.added.length, assistants.added.length);
        }
        if (prior.phase === "owned_assistant_terminal"
            && (ownedAssistant.state !== "terminal"
                || ownedAssistant.evidenceDigest !== prior.assistantEvidenceDigest
                || ownedAssistant.structureDigest !== prior.assistantStructureDigest)) {
            return result(input, "ownership_ambiguous", "prior_owned_turn_changed", target, user, ownedAssistant, undefined, users.added.length, assistants.added.length);
        }
        const phase = assistantPhase(input.binding, input.snapshot, ownedAssistant);
        if (phase === undefined) {
            return result(input, "ownership_ambiguous", "terminal_state_mismatch", target, user, ownedAssistant, undefined, users.added.length, assistants.added.length);
        }
        const cursor = makeCursor(binding, user, ownedAssistant, phase, snapshot.snapshotDigest);
        return result(input, phase, "none", target, user, ownedAssistant, cursor, users.added.length, assistants.added.length);
    }
    const children = assistants.added.filter(turn => turn.parentStableId === user.stableId);
    const unrelated = assistants.added.filter(turn => turn.parentStableId !== user.stableId);
    if (unrelated.length > 0) {
        return result(input, "ownership_ambiguous", "assistant_parent_mismatch", target, user, unrelated[0], undefined, users.added.length, assistants.added.length);
    }
    if (children.length === 0) {
        if (snapshot.terminalState === "terminal") {
            return result(input, "ownership_ambiguous", "terminal_state_mismatch", target, user, undefined, undefined, users.added.length, 0);
        }
        const cursor = makeCursor(binding, user, undefined, "owned_user_turn", snapshot.snapshotDigest);
        return result(input, "owned_user_turn", "none", target, user, undefined, cursor, users.added.length, 0);
    }
    if (children.length > 1) {
        return result(input, "regeneration_ambiguous", "regeneration_siblings", target, user, children[0], undefined, users.added.length, assistants.added.length);
    }
    const assistant = children[0];
    if (assistant === undefined) {
        return result(input, "ownership_ambiguous", "stable_assistant_turn_id_unavailable", target, user, undefined, undefined, users.added.length, assistants.added.length);
    }
    const phase = assistantPhase(binding, snapshot, assistant);
    if (phase === undefined) {
        return result(input, "ownership_ambiguous", assistant.state === undefined ? "assistant_state_unknown" : "terminal_state_mismatch", target, user, assistant, undefined, users.added.length, assistants.added.length);
    }
    const cursor = makeCursor(binding, user, assistant, phase, snapshot.snapshotDigest);
    return result(input, phase, "none", target, user, assistant, cursor, users.added.length, assistants.added.length);
}
function proveSubmittedUser(input, user) {
    const { binding, baseline, snapshot, submissionWitness } = input;
    if (user.stableId === undefined || binding.evidenceProfile.stableUserTurnId === "unavailable") {
        return { ok: false, status: "ownership_ambiguous", reason: "stable_user_turn_id_unavailable" };
    }
    if (submissionWitness === undefined)
        return { ok: false, status: "ownership_ambiguous", reason: "post_send_delta_missing" };
    if (submissionWitness.actionId !== binding.actionId || submissionWitness.actionKind !== binding.actionKind)
        return { ok: false, status: "ownership_ambiguous", reason: "operation_user_evidence_mismatch" };
    if (submissionWitness.baselineSnapshotDigest !== baseline.snapshotDigest)
        return { ok: false, status: "ownership_ambiguous", reason: "post_send_delta_mismatch" };
    const delta = snapshot.postSendDelta;
    if (delta === undefined)
        return { ok: false, status: "ownership_ambiguous", reason: "post_send_delta_missing" };
    if (delta.baselineSnapshotDigest !== baseline.snapshotDigest)
        return { ok: false, status: "ownership_ambiguous", reason: "post_send_delta_mismatch" };
    if (delta.deltaDigest !== submissionWitness.postSendDeltaDigest)
        return { ok: false, status: "ownership_ambiguous", reason: "post_send_delta_mismatch" };
    if (delta.addedUserEvidenceDigests.length !== 1 || delta.addedUserEvidenceDigests[0] !== user.evidenceDigest) {
        return { ok: false, status: "concurrent_user_turn", reason: "multiple_new_user_turns" };
    }
    if (user.evidenceDigest !== submissionWitness.operationUserEvidenceDigest) {
        return { ok: false, status: "concurrent_user_turn", reason: "operation_user_evidence_mismatch" };
    }
    if (submissionWitness.userTurnStableId !== undefined && submissionWitness.userTurnStableId !== user.stableId) {
        return { ok: false, status: "concurrent_user_turn", reason: "operation_user_evidence_mismatch" };
    }
    return { ok: true };
}
function classifyFreshOwnedUser(input, target, user, assistants) {
    const { binding, snapshot } = input;
    const children = assistants.added.filter(turn => turn.parentStableId === user.stableId);
    const unrelated = assistants.added.filter(turn => turn.parentStableId !== user.stableId);
    if (unrelated.length > 0) {
        return result(input, "ownership_ambiguous", "assistant_parent_mismatch", target, user, unrelated[0], undefined, 1, assistants.added.length);
    }
    if (children.length === 0) {
        if (snapshot.terminalState === "terminal") {
            return result(input, "ownership_ambiguous", "terminal_state_mismatch", target, user, undefined, undefined, 1, 0);
        }
        const cursor = makeCursor(binding, user, undefined, "owned_user_turn", snapshot.snapshotDigest);
        return result(input, "owned_user_turn", "none", target, user, undefined, cursor, 1, 0);
    }
    if (children.length > 1) {
        return result(input, "regeneration_ambiguous", "regeneration_siblings", target, user, children[0], undefined, 1, assistants.added.length);
    }
    const assistant = children[0];
    if (assistant === undefined) {
        return result(input, "ownership_ambiguous", "stable_assistant_turn_id_unavailable", target, user, undefined, undefined, 1, assistants.added.length);
    }
    const phase = assistantPhase(binding, snapshot, assistant);
    if (phase === undefined) {
        const reason = assistant.state === undefined
            ? "assistant_state_unknown"
            : assistant.parentStableId === undefined
                ? "stable_parent_identity_unavailable"
                : assistant.branchStableId === undefined
                    ? "stable_branch_identity_unavailable"
                    : "terminal_state_mismatch";
        return result(input, "ownership_ambiguous", reason, target, user, assistant, undefined, 1, assistants.added.length);
    }
    const cursor = makeCursor(binding, user, assistant, phase, snapshot.snapshotDigest);
    return result(input, phase, "none", target, user, assistant, cursor, 1, assistants.added.length);
}
function assistantPhase(binding, snapshot, assistant) {
    if (binding.evidenceProfile.stableAssistantTurnId === "unavailable" || assistant.stableId === undefined)
        return undefined;
    if (binding.evidenceProfile.stableBranchId === "unavailable" || assistant.branchStableId === undefined || assistant.parentStableId === undefined)
        return undefined;
    if (assistant.state === undefined)
        return undefined;
    if (assistant.state === "generating") {
        return snapshot.terminalState === "generating" ? "owned_assistant_generating" : undefined;
    }
    return snapshot.terminalState === "terminal" ? "owned_assistant_terminal" : undefined;
}
function makeCursor(binding, user, assistant, phase, snapshotDigest) {
    if (user.stableId === undefined)
        return undefined;
    if (assistant !== undefined && (assistant.stableId === undefined || assistant.branchStableId === undefined))
        return undefined;
    const cursor = {
        schemaVersion: TURN_OWNERSHIP_SCHEMA_VERSION,
        operationId: binding.operationId,
        targetBindingDigest: binding.targetBindingDigest,
        phase,
        userTurnId: user.stableId,
        userTurnEvidenceDigest: user.evidenceDigest,
        ...(assistant === undefined ? {} : {
            assistantTurnId: assistant.stableId,
            assistantBranchId: assistant.branchStableId,
            assistantEvidenceDigest: assistant.evidenceDigest,
            assistantStructureDigest: assistant.structureDigest
        }),
        snapshotDigest
    };
    validateOwnershipCursor(cursor);
    return Object.freeze(cursor);
}
function result(input, status, reason, target, user, assistant, cursor, addedUserCount, addedAssistantCount) {
    const evidence = freezeEvidence({
        schemaVersion: TURN_OWNERSHIP_SCHEMA_VERSION,
        operationId: input.binding.operationId,
        status,
        reason,
        target: targetMaterial(input.binding, input.snapshot.target, target),
        baselineSnapshotDigest: input.baseline.snapshotDigest,
        snapshotDigest: input.snapshot.snapshotDigest,
        ...(input.snapshot.postSendDelta === undefined ? {} : { postSendDeltaDigest: input.snapshot.postSendDelta.deltaDigest }),
        addedUserCount,
        addedAssistantCount,
        terminalState: input.snapshot.terminalState,
        ...(user === undefined ? {} : { userTurn: turnMaterial(user) }),
        ...(assistant === undefined ? {} : { assistantTurn: turnMaterial(assistant) })
    });
    const recoveryObservation = status === "no_operation_turn"
        ? { status: "not_observed" }
        : status === "owned_user_turn" && user?.stableId !== undefined
            ? { status: "owned_user_turn", userTurnId: user.stableId, evidenceDigest: input.snapshot.snapshotDigest }
            : status === "owned_assistant_generating" && user?.stableId !== undefined && assistant?.stableId !== undefined
                ? { status: "owned_assistant_generating", userTurnId: user.stableId, assistantTurnId: assistant.stableId, evidenceDigest: input.snapshot.snapshotDigest }
                : status === "owned_assistant_terminal" && user?.stableId !== undefined && assistant?.stableId !== undefined
                    ? { status: "owned_assistant_terminal", userTurnId: user.stableId, assistantTurnId: assistant.stableId, evidenceDigest: input.snapshot.snapshotDigest }
                    : { status: "ambiguous", evidenceDigest: input.snapshot.snapshotDigest };
    return Object.freeze({
        status,
        reason,
        evidence,
        recoveryObservation,
        ...(cursor === undefined ? {} : { cursor })
    });
}
function targetMaterial(binding, snapshotTarget, check) {
    return {
        provider: snapshotTarget.provider.status,
        browser: snapshotTarget.browser.status,
        tab: snapshotTarget.tab.status,
        thread: snapshotTarget.thread.status,
        conversation: snapshotTarget.conversation.status,
        canonicalThreadUrl: snapshotTarget.canonicalThreadUrl.status,
        authoritativeTabClaim: snapshotTarget.authoritativeTabClaim.status,
        replacedTab: check.replacedTab && binding.replacementTabRecovery
    };
}
function turnMaterial(turn) {
    return {
        evidenceDigest: turn.evidenceDigest,
        structureDigest: turn.structureDigest,
        ordinal: turn.ordinal,
        stableIdAvailable: turn.stableId !== undefined,
        parentStableIdAvailable: turn.parentStableId !== undefined,
        branchStableIdAvailable: turn.branchStableId !== undefined,
        artifactEvidenceDigests: Object.freeze([...(turn.artifactEvidenceDigests ?? [])]),
        ...(turn.state === undefined ? {} : { state: turn.state })
    };
}
function freezeEvidence(material) {
    const target = Object.freeze({ ...material.target });
    const userTurn = material.userTurn === undefined ? undefined : Object.freeze({ ...material.userTurn, artifactEvidenceDigests: Object.freeze([...material.userTurn.artifactEvidenceDigests]) });
    const assistantTurn = material.assistantTurn === undefined ? undefined : Object.freeze({ ...material.assistantTurn, artifactEvidenceDigests: Object.freeze([...material.assistantTurn.artifactEvidenceDigests]) });
    return Object.freeze({ ...material, target, ...(userTurn === undefined ? {} : { userTurn }), ...(assistantTurn === undefined ? {} : { assistantTurn }) });
}
function compareBindingToTarget(binding, target) {
    const bound = binding.target;
    if (bound.coordinationScope !== target.coordinationScope)
        return { status: "mismatch", replacedTab: false };
    const exactKeys = [
        "provider",
        "browser",
        "thread",
        "conversation",
        "canonicalThreadUrl"
    ];
    for (const key of exactKeys) {
        const left = bound[key];
        const right = target[key];
        if (left.status === "unavailable" || right.status === "unavailable") {
            // An explicitly unavailable optional identity is only safe when both
            // sides agree that it is unavailable.  A newly observed value cannot
            // silently bypass the operation's exact binding.
            if (left.status === "unavailable" && right.status === "unavailable"
                && (key === "thread" || key === "conversation" || key === "canonicalThreadUrl"))
                continue;
            return { status: "unavailable", replacedTab: false };
        }
        if (left.value !== right.value)
            return { status: "mismatch", replacedTab: false };
    }
    if (bound.tab.status === "unavailable" || target.tab.status === "unavailable")
        return { status: "unavailable", replacedTab: false };
    if (binding.evidenceProfile.authoritativeTabClaim === "required"
        && (bound.authoritativeTabClaim.status === "unavailable" || target.authoritativeTabClaim.status === "unavailable")) {
        return { status: "unavailable", replacedTab: false };
    }
    if (bound.tab.value !== target.tab.value) {
        if (!binding.replacementTabRecovery)
            return { status: "mismatch", replacedTab: false };
        if (binding.evidenceProfile.stableConversationId !== "required")
            return { status: "unavailable", replacedTab: false };
        if (target.authoritativeTabClaim.status === "unavailable")
            return { status: "unavailable", replacedTab: false };
        return { status: "replacement", replacedTab: true };
    }
    if (binding.evidenceProfile.authoritativeTabClaim === "required"
        && bound.authoritativeTabClaim.status === "available"
        && target.authoritativeTabClaim.status === "available"
        && bound.authoritativeTabClaim.value !== target.authoritativeTabClaim.value) {
        return { status: "mismatch", replacedTab: false };
    }
    return { status: "match", replacedTab: false };
}
/**
 * A genuine new target has no provider conversation identity in its durable
 * pre-Send baseline. After the journal accepts the one-way establishment and
 * exact post-Send witness, collection may compare the established binding to
 * the live snapshot without pretending that identity existed before Send.
 */
function compareBindingToBaselineTarget(binding, baseline, submissionWitness) {
    const direct = compareBindingToTarget(binding, baseline.target);
    if (direct.status !== "unavailable")
        return direct;
    const pending = baseline.target;
    const established = binding.target;
    const pendingConversationIdentity = pending.thread.status === "unavailable"
        && pending.conversation.status === "unavailable"
        && pending.canonicalThreadUrl.status === "unavailable";
    const establishedConversationIdentity = established.thread.status === "available"
        && established.conversation.status === "available"
        && established.canonicalThreadUrl.status === "available";
    const exactWitness = submissionWitness !== undefined
        && submissionWitness.actionId === binding.actionId
        && submissionWitness.actionKind === "send"
        && binding.actionKind === "send"
        && submissionWitness.baselineSnapshotDigest === baseline.snapshotDigest;
    if (!pendingConversationIdentity
        || !establishedConversationIdentity
        || baseline.userTurns.length !== 0
        || baseline.assistantTurns.length !== 0
        || binding.evidenceProfile.stableConversationId !== "required"
        || binding.evidenceProfile.stableUserTurnId !== "required"
        || !exactWitness)
        return direct;
    return compareBindingToTarget(binding, Object.freeze({
        ...pending,
        thread: established.thread,
        conversation: established.conversation,
        canonicalThreadUrl: established.canonicalThreadUrl
    }));
}
function hasStableConversationAndClaim(binding, snapshot) {
    return binding.evidenceProfile.stableConversationId === "required"
        && snapshot.target.conversation.status === "available"
        && snapshot.target.thread.status === "available"
        && snapshot.target.authoritativeTabClaim.status === "available";
}
function analyzeDelta(baseline, fresh) {
    const baselineIndices = [];
    const used = new Set();
    const freshByIdentity = new Map();
    for (let index = 0; index < fresh.length; index += 1) {
        const turn = fresh[index];
        if (turn === undefined)
            continue;
        // Validation has already rejected duplicates in one snapshot.  Keeping a
        // map here makes the delta proof O(n), rather than scanning the page for
        // every baseline turn.
        freshByIdentity.set(turnIdentityKey(turn), { index, turn });
    }
    for (const prior of baseline) {
        const found = freshByIdentity.get(turnIdentityKey(prior));
        if (found === undefined || used.has(found.index))
            return { valid: false, reason: "baseline_turn_missing", added: [], intervening: false };
        const match = found.index;
        const matched = found.turn;
        if (prior.evidenceDigest !== matched.evidenceDigest || prior.structureDigest !== matched.structureDigest) {
            return { valid: false, reason: "baseline_turn_changed", added: [], intervening: false };
        }
        used.add(match);
        baselineIndices.push(match);
    }
    for (let index = 1; index < baselineIndices.length; index += 1) {
        if ((baselineIndices[index - 1] ?? -1) >= (baselineIndices[index] ?? -1)) {
            return { valid: false, reason: "out_of_order_snapshot", added: [], intervening: false };
        }
    }
    const added = [];
    let baselineCursor = 0;
    let intervening = false;
    for (let index = 0; index < fresh.length; index += 1) {
        if (baselineCursor < baselineIndices.length && baselineIndices[baselineCursor] === index) {
            baselineCursor += 1;
            continue;
        }
        const turn = fresh[index];
        if (turn !== undefined)
            added.push(turn);
        if (baselineIndices.length > 0) {
            const firstBaseline = baselineIndices[0] ?? 0;
            const nextBaseline = baselineIndices[baselineCursor];
            if (index < firstBaseline || (nextBaseline !== undefined && index < nextBaseline))
                intervening = true;
        }
    }
    return { valid: true, added, intervening };
}
function turnIdentityKey(turn) {
    return turn.stableId === undefined ? `e:${turn.evidenceDigest}` : `i:${turn.stableId}`;
}
function validateInput(input) {
    if (!isRecord(input))
        throw new TypeError("Turn ownership input must be an object.");
    assertExactKeys(input, "input", ["binding", "baseline", "snapshot", "submissionWitness", "prior"], ["binding", "baseline", "snapshot"]);
    validateBinding(input.binding);
    validateBaseline(input.baseline);
    validateSnapshot(input.snapshot);
    if (input.submissionWitness !== undefined)
        validateSubmissionWitness(input.submissionWitness);
    if (input.prior !== undefined)
        validateOwnershipCursor(input.prior);
}
function validateBinding(binding) {
    if (!isRecord(binding) || binding.schemaVersion !== TURN_OWNERSHIP_SCHEMA_VERSION)
        throw new TypeError("Unsupported ownership binding schema version.");
    assertExactKeys(binding, "binding", ["schemaVersion", "operationId", "targetBindingDigest", "target", "evidenceProfile", "replacementTabRecovery", "actionId", "actionKind"], ["schemaVersion", "operationId", "targetBindingDigest", "target", "evidenceProfile", "replacementTabRecovery", "actionId", "actionKind"]);
    assertIdentifier(binding.operationId, "binding.operationId");
    assertDigest(binding.targetBindingDigest, "binding.targetBindingDigest");
    assertIdentifier(binding.actionId, "binding.actionId");
    if (binding.actionKind !== "send" && binding.actionKind !== "work_steer")
        throw new TypeError("Invalid ownership action kind.");
    if (typeof binding.replacementTabRecovery !== "boolean")
        throw new TypeError("replacementTabRecovery must be boolean.");
    validateTarget(binding.target, "binding.target");
    if (!isRecord(binding.evidenceProfile))
        throw new TypeError("binding.evidenceProfile must be an object.");
    assertExactKeys(binding.evidenceProfile, "binding.evidenceProfile", ["stableConversationId", "stableUserTurnId", "stableAssistantTurnId", "stableBranchId", "authoritativeTabClaim"], ["stableConversationId", "stableUserTurnId", "stableAssistantTurnId", "stableBranchId", "authoritativeTabClaim"]);
    for (const key of ["stableConversationId", "stableUserTurnId", "stableAssistantTurnId", "stableBranchId", "authoritativeTabClaim"]) {
        if (binding.evidenceProfile[key] !== "required" && binding.evidenceProfile[key] !== "unavailable")
            throw new TypeError(`Invalid evidence profile ${key}.`);
    }
    if (binding.evidenceProfile.stableConversationId === "required" && binding.target.conversation.status !== "available")
        throw new TypeError("Stable conversation evidence is required but unavailable in the binding.");
    if (binding.evidenceProfile.authoritativeTabClaim === "required" && binding.target.authoritativeTabClaim.status !== "available")
        throw new TypeError("Authoritative tab claim is required but unavailable in the binding.");
    if (binding.replacementTabRecovery
        && (binding.evidenceProfile.stableConversationId !== "required" || binding.evidenceProfile.authoritativeTabClaim !== "required")) {
        throw new TypeError("Replacement-tab recovery requires stable conversation identity and authoritative tab claims.");
    }
    if (binding.target.coordinationScope === "provider" && binding.target.authoritativeTabClaim.status !== "available")
        throw new TypeError("Provider-scoped ownership requires an authoritative tab claim.");
}
function validateBaseline(baseline) {
    if (!isRecord(baseline) || baseline.schemaVersion !== TURN_OWNERSHIP_SCHEMA_VERSION || baseline.completeness !== "complete")
        throw new TypeError("Baseline must be a complete ownership snapshot.");
    assertExactKeys(baseline, "baseline", ["schemaVersion", "snapshotDigest", "target", "userTurns", "assistantTurns", "completeness"], ["schemaVersion", "snapshotDigest", "target", "userTurns", "assistantTurns", "completeness"]);
    assertDigest(baseline.snapshotDigest, "baseline.snapshotDigest");
    validateTarget(baseline.target, "baseline.target");
    validateTurns(baseline.userTurns, "user", "baseline.userTurns");
    validateTurns(baseline.assistantTurns, "assistant", "baseline.assistantTurns");
}
function validateSnapshot(snapshot) {
    if (!isRecord(snapshot) || snapshot.schemaVersion !== TURN_OWNERSHIP_SCHEMA_VERSION)
        throw new TypeError("Unsupported ownership snapshot schema version.");
    assertExactKeys(snapshot, "snapshot", ["schemaVersion", "snapshotDigest", "target", "userTurns", "assistantTurns", "completeness", "terminalState", "postSendDelta"], ["schemaVersion", "snapshotDigest", "target", "userTurns", "assistantTurns", "completeness", "terminalState"]);
    assertDigest(snapshot.snapshotDigest, "snapshot.snapshotDigest");
    validateTarget(snapshot.target, "snapshot.target");
    validateTurns(snapshot.userTurns, "user", "snapshot.userTurns");
    validateTurns(snapshot.assistantTurns, "assistant", "snapshot.assistantTurns");
    if (snapshot.completeness !== "complete" && snapshot.completeness !== "truncated" && snapshot.completeness !== "incomplete" && snapshot.completeness !== "out_of_order")
        throw new TypeError("Invalid snapshot completeness.");
    if (snapshot.terminalState !== "idle" && snapshot.terminalState !== "generating" && snapshot.terminalState !== "terminal" && snapshot.terminalState !== "unknown")
        throw new TypeError("Invalid snapshot terminal state.");
    if (snapshot.postSendDelta !== undefined) {
        if (!isRecord(snapshot.postSendDelta))
            throw new TypeError("snapshot.postSendDelta must be an object.");
        assertExactKeys(snapshot.postSendDelta, "snapshot.postSendDelta", ["baselineSnapshotDigest", "addedUserEvidenceDigests", "deltaDigest"], ["baselineSnapshotDigest", "addedUserEvidenceDigests", "deltaDigest"]);
        assertDigest(snapshot.postSendDelta.baselineSnapshotDigest, "snapshot.postSendDelta.baselineSnapshotDigest");
        assertDigest(snapshot.postSendDelta.deltaDigest, "snapshot.postSendDelta.deltaDigest");
        assertBoundedArray(snapshot.postSendDelta.addedUserEvidenceDigests, MAX_TURNS, "snapshot.postSendDelta.addedUserEvidenceDigests");
        const seen = new Set();
        for (const digest of snapshot.postSendDelta.addedUserEvidenceDigests) {
            assertDigest(digest, "snapshot.postSendDelta.addedUserEvidenceDigests[]");
            if (seen.has(digest))
                throw new TypeError("Duplicate post-Send user evidence digest.");
            seen.add(digest);
        }
    }
}
function validateSubmissionWitness(witness) {
    if (!isRecord(witness))
        throw new TypeError("submissionWitness must be an object.");
    assertExactKeys(witness, "submissionWitness", ["actionId", "actionKind", "baselineSnapshotDigest", "postSendDeltaDigest", "operationUserEvidenceDigest", "userTurnStableId"], ["actionId", "actionKind", "baselineSnapshotDigest", "postSendDeltaDigest", "operationUserEvidenceDigest"]);
    assertIdentifier(witness.actionId, "submissionWitness.actionId");
    if (witness.actionKind !== "send" && witness.actionKind !== "work_steer")
        throw new TypeError("Invalid submission witness action kind.");
    assertDigest(witness.baselineSnapshotDigest, "submissionWitness.baselineSnapshotDigest");
    assertDigest(witness.postSendDeltaDigest, "submissionWitness.postSendDeltaDigest");
    assertDigest(witness.operationUserEvidenceDigest, "submissionWitness.operationUserEvidenceDigest");
    if (witness.userTurnStableId !== undefined)
        assertIdentifier(witness.userTurnStableId, "submissionWitness.userTurnStableId");
}
function validateTarget(target, label) {
    if (!isRecord(target))
        throw new TypeError(`${label} must be an object.`);
    assertExactKeys(target, label, ["provider", "browser", "tab", "thread", "conversation", "canonicalThreadUrl", "authoritativeTabClaim", "coordinationScope"], ["provider", "browser", "tab", "thread", "conversation", "canonicalThreadUrl", "authoritativeTabClaim", "coordinationScope"]);
    for (const key of ["provider", "browser", "tab", "thread", "conversation", "authoritativeTabClaim"])
        validateIdentity(target[key], `${label}.${key}`);
    validateIdentity(target.canonicalThreadUrl, `${label}.canonicalThreadUrl`, true);
    if (target.coordinationScope !== "process" && target.coordinationScope !== "provider")
        throw new TypeError(`${label}.coordinationScope is invalid.`);
    if (target.coordinationScope === "provider" && target.authoritativeTabClaim.status !== "available")
        throw new TypeError(`${label} requires an authoritative claim for provider coordination.`);
    if (target.canonicalThreadUrl.status === "available") {
        let url;
        try {
            url = new URL(target.canonicalThreadUrl.value);
        }
        catch {
            throw new TypeError(`${label}.canonicalThreadUrl is not a URL.`);
        }
        if (url.protocol !== "https:" || url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "")
            throw new TypeError(`${label}.canonicalThreadUrl must be canonical HTTPS without credentials, query, or fragment.`);
    }
}
function validateIdentity(identity, label, allowUrl = false) {
    if (!isRecord(identity) || (identity.status !== "available" && identity.status !== "unavailable"))
        throw new TypeError(`${label} has invalid availability.`);
    if (identity.status === "available") {
        assertExactKeys(identity, label, ["status", "value"], ["status", "value"]);
        if (!allowUrl)
            assertIdentifier(identity.value, `${label}.value`);
        else if (typeof identity.value !== "string" || identity.value.length < 1 || identity.value.length > 4096 || /[\u0000-\u001f\u007f]/u.test(identity.value))
            throw new TypeError(`${label}.value must be a bounded URL.`);
    }
    else {
        assertExactKeys(identity, label, ["status", "reason"], ["status", "reason"]);
        if (identity.reason !== "not_exposed" && identity.reason !== "not_observed" && identity.reason !== "redacted")
            throw new TypeError(`${label}.reason is invalid.`);
    }
}
function validateTurns(turns, kind, label) {
    assertBoundedArray(turns, MAX_TURNS, label);
    const stableIds = new Set();
    const evidence = new Set();
    for (let index = 0; index < turns.length; index += 1) {
        const turn = turns[index];
        if (!isRecord(turn))
            throw new TypeError(`${label}[${index}] must be an object.`);
        assertExactKeys(turn, `${label}[${index}]`, ["stableId", "evidenceDigest", "structureDigest", "ordinal", "parentStableId", "branchStableId", "state", "artifactEvidenceDigests"], ["evidenceDigest", "structureDigest", "ordinal"]);
        if (turn.ordinal !== index)
            throw new TypeError(`${label} ordinals must be contiguous and ordered.`);
        assertDigest(turn.evidenceDigest, `${label}[${index}].evidenceDigest`);
        assertDigest(turn.structureDigest, `${label}[${index}].structureDigest`);
        if (turn.stableId !== undefined) {
            assertIdentifier(turn.stableId, `${label}[${index}].stableId`);
            if (stableIds.has(turn.stableId))
                throw new TypeError(`Duplicate stable turn ID in ${label}.`);
            stableIds.add(turn.stableId);
        }
        if (kind === "user" && (turn.state !== undefined || turn.parentStableId !== undefined || turn.branchStableId !== undefined))
            throw new TypeError("User turns cannot carry assistant state or lineage.");
        if (kind === "assistant" && turn.state !== "generating" && turn.state !== "terminal")
            throw new TypeError("Assistant turns require generating or terminal state.");
        if (turn.parentStableId !== undefined)
            assertIdentifier(turn.parentStableId, `${label}[${index}].parentStableId`);
        if (turn.branchStableId !== undefined)
            assertIdentifier(turn.branchStableId, `${label}[${index}].branchStableId`);
        assertBoundedArray(turn.artifactEvidenceDigests ?? [], MAX_ARTIFACTS_PER_TURN, `${label}[${index}].artifactEvidenceDigests`);
        const artifactDigests = new Set();
        for (const digest of turn.artifactEvidenceDigests ?? []) {
            assertDigest(digest, `${label}[${index}].artifactEvidenceDigests[]`);
            if (artifactDigests.has(digest))
                throw new TypeError(`Duplicate artifact evidence digest in ${label}.`);
            artifactDigests.add(digest);
        }
        // Identical content is allowed when stable IDs differ, but two id-less
        // turns with one evidence digest cannot be distinguished safely.
        if (turn.stableId === undefined) {
            if (evidence.has(turn.evidenceDigest))
                throw new TypeError(`Duplicate id-less turn evidence in ${label}.`);
            evidence.add(turn.evidenceDigest);
        }
    }
}
function assertIdentifier(value, label) {
    if (typeof value !== "string" || value.length < 1 || value.length > MAX_IDENTIFIER_LENGTH || !IDENTIFIER_PATTERN.test(value))
        throw new TypeError(`${label} must be a bounded opaque identifier.`);
}
function assertDigest(value, label) {
    if (typeof value !== "string" || value.length > MAX_DIGEST_LENGTH || !DIGEST_PATTERN.test(value))
        throw new TypeError(`${label} must be a bounded digest.`);
}
function assertBoundedArray(value, max, label) {
    if (!Array.isArray(value) || value.length > max)
        throw new TypeError(`${label} exceeds its bounded array cap.`);
}
function assertExactKeys(value, label, allowed, required) {
    const allowedSet = new Set(allowed);
    for (const key of Object.keys(value)) {
        if (!allowedSet.has(key))
            throw new TypeError(`${label} contains unsupported field ${key}.`);
    }
    for (const key of required) {
        if (!Object.prototype.hasOwnProperty.call(value, key))
            throw new TypeError(`${label} is missing required field ${key}.`);
    }
}
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
