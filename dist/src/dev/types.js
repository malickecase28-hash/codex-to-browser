export const DEV_STATE_SCHEMA_VERSION = "chatgpt.browser_control.dev_state.v1";
export const DEV_RECEIPT_SCHEMA_VERSION = "chatgpt.browser_control.dev_receipt.v1";
export class DevOrchestratorError extends Error {
    code;
    recoverable;
    constructor(code, message, recoverable = true) {
        super(message);
        this.code = code;
        this.recoverable = recoverable;
        this.name = "DevOrchestratorError";
    }
}
