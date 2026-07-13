import { CairnError } from "../errors.js";
import type { CairnConfig } from "../config.js";
import type { Tracker } from "./types.js";
/**
 * Distinguishes between missing adapter modules (not yet implemented) and
 * adapter modules that exist but fail to load (syntax error, broken import, etc).
 */
export declare function importErrorToCairn(type: string, e: unknown): CairnError;
export declare function makeTracker(cfg: CairnConfig): Promise<Tracker>;
