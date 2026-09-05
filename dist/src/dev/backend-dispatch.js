const DEV_BACKEND_NAMESPACES = new Set(["projects", "planner", "worker", "autonomous"]);
const DEV_BACKEND_ACTION_LIMIT = 64;
export class DevBackendDispatchError extends Error {
    constructor(message = "Development backend dispatch payload is invalid.") {
        super(message);
        this.name = "DevBackendDispatchError";
    }
}
export async function dispatchDevBackend(dev, payload) {
    const namespace = boundedString(payload.namespace);
    const action = boundedString(payload.action);
    if (namespace === undefined || !DEV_BACKEND_NAMESPACES.has(namespace) || action === undefined) {
        throw new DevBackendDispatchError();
    }
    const args = optionalRecord(payload.args);
    switch (namespace) {
        case "projects":
            return dispatchProjects(dev, action, args);
        case "planner":
            return dispatchPlanner(dev, action, args);
        case "worker":
            return dispatchWorker(dev, action, args);
        case "autonomous":
            return dispatchAutonomous(dev, action, args);
        default:
            throw new DevBackendDispatchError();
    }
}
async function dispatchProjects(dev, action, args) {
    switch (action) {
        case "list":
            return dev.projects.list(optionalRecordOrUndefined(args.filters));
        case "get":
            return dev.projects.get(requiredValue(args, "ref"));
        case "find":
            return dev.projects.find(requiredString(args, "query"));
        case "open":
            return dev.projects.open(requiredValue(args, "ref"));
        case "ensure":
            return dev.projects.ensure(requiredRecord(args, "spec"));
        case "create":
            return dev.projects.create(requiredRecord(args, "spec"));
        case "update":
            return dev.projects.update(requiredValue(args, "ref"), requiredRecord(args, "changes"));
        case "delete":
            return dev.projects.delete(requiredValue(args, "ref"), optionalRecordOrUndefined(args.options));
        case "chats.list":
            return dev.projects.chats.list(requiredValue(args, "ref"));
        case "chats.open":
            return dev.projects.chats.open(requiredValue(args, "ref"), requiredString(args, "chatRef"));
        case "context.inspect":
            return dev.projects.context.inspect(requiredValue(args, "ref"));
        default:
            throw new DevBackendDispatchError();
    }
}
async function dispatchPlanner(dev, action, args) {
    switch (action) {
        case "inspect":
            return dev.planner.inspect();
        case "list":
            return dev.planner.list();
        case "get":
            return dev.planner.get(requiredValue(args, "ref"));
        case "find":
            return dev.planner.find(requiredString(args, "query"));
        case "create":
            return dev.planner.create(requiredRecord(args, "spec"));
        case "update":
            return dev.planner.update(requiredValue(args, "ref"), requiredRecord(args, "changes"));
        case "delete":
            return dev.planner.delete(requiredValue(args, "ref"), optionalRecordOrUndefined(args.options));
        case "setEnabled":
            return dev.planner.setEnabled(requiredValue(args, "ref"), requiredBoolean(args, "enabled"), optionalRecordOrUndefined(args.options));
        case "runs":
            return dev.planner.runs(requiredValue(args, "ref"));
        case "runNow":
            return dev.planner.runNow(requiredValue(args, "ref"), optionalRecordOrUndefined(args.options));
        default:
            throw new DevBackendDispatchError();
    }
}
async function dispatchWorker(dev, action, args) {
    switch (action) {
        case "start":
            return dev.worker.start(requiredRecord(args, "spec"));
        case "stop":
            return dev.worker.stop(requiredValue(args, "ref"));
        case "status":
            return dev.worker.status(requiredValue(args, "ref"));
        case "list":
            return dev.worker.list();
        default:
            throw new DevBackendDispatchError();
    }
}
async function dispatchAutonomous(dev, action, args) {
    switch (action) {
        case "plan":
            return dev.autonomous.plan(requiredRecord(args, "spec"), optionalRecordOrUndefined(args.options));
        case "bootstrap":
            return dev.autonomous.bootstrap(requiredRecord(args, "spec"), optionalRecordOrUndefined(args.options));
        case "create":
            return dev.autonomous.create(requiredRecord(args, "plan"));
        case "get":
            return dev.autonomous.get(requiredString(args, "workflowId"));
        case "advance":
            return dev.autonomous.advance(requiredString(args, "workflowId"), optionalRecordOrUndefined(args.options));
        case "run":
            return dev.autonomous.run(requiredString(args, "workflowId"), optionalRecordOrUndefined(args.options));
        case "resumeTask":
            return dev.autonomous.resumeTask(requiredString(args, "workflowId"), requiredString(args, "taskId"));
        case "resumeIntegration":
            return dev.autonomous.resumeIntegration(requiredString(args, "workflowId"));
        default:
            throw new DevBackendDispatchError();
    }
}
function boundedString(value) {
    return typeof value === "string"
        && value.length > 0
        && value.length <= DEV_BACKEND_ACTION_LIMIT
        && value.trim() === value
        && !/[\u0000-\u001f\u007f]/u.test(value)
        ? value
        : undefined;
}
function requiredString(record, key) {
    const value = boundedString(record[key]);
    if (value === undefined)
        throw new DevBackendDispatchError();
    return value;
}
function requiredBoolean(record, key) {
    const value = record[key];
    if (typeof value !== "boolean")
        throw new DevBackendDispatchError();
    return value;
}
function requiredRecord(record, key) {
    const value = record[key];
    if (!isRecord(value))
        throw new DevBackendDispatchError();
    return value;
}
function requiredValue(record, key) {
    if (!Object.hasOwn(record, key) || record[key] === undefined || record[key] === null) {
        throw new DevBackendDispatchError();
    }
    return record[key];
}
function optionalRecord(value) {
    if (value === undefined)
        return {};
    if (!isRecord(value))
        throw new DevBackendDispatchError();
    return value;
}
function optionalRecordOrUndefined(value) {
    if (value === undefined)
        return undefined;
    if (!isRecord(value))
        throw new DevBackendDispatchError();
    return value;
}
function isRecord(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}
