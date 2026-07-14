import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
export function checkProvenance(projectDir, file, commit) {
    if (!existsSync(join(projectDir, file)))
        return "deleted";
    try {
        execFileSync("git", ["diff", "--quiet", commit, "--", file], { cwd: projectDir, stdio: "ignore" });
        return "unchanged";
    }
    catch (e) {
        return e.status === 1 ? "changed" : "unknown";
    }
}
export function checkCardStaleness(projectDir, provenance) {
    const reasons = [];
    for (const p of provenance) {
        const status = checkProvenance(projectDir, p.file, p.commit);
        if (status === "changed")
            reasons.push(`${p.file} changed since ${p.commit.slice(0, 7)}`);
        else if (status === "deleted")
            reasons.push(`${p.file} no longer exists`);
        else if (status === "unknown")
            reasons.push(`${p.file}: could not verify against ${p.commit.slice(0, 7)}`);
    }
    return { stale: reasons.length > 0, reasons };
}
