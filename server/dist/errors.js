export class CairnError extends Error {
    code;
    nextAction;
    constructor(code, message, nextAction) {
        super(message);
        this.code = code;
        this.nextAction = nextAction;
        this.name = "CairnError";
    }
}
