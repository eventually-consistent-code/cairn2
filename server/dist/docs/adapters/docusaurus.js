// Docusaurus docs connector — filesystem backend. Docusaurus has no runtime
// page API: the site's docs/ folder IS the store. Pages are markdown files
// with front matter, the tree is folders + _category_.json, and deploy stays
// with the user's CI. Page.id = path relative to docsDir (POSIX separators).
// Everything under the project's root folder is cairn-managed; nothing
// outside it is ever touched.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, } from "node:fs";
import { join, posix, resolve } from "node:path";
import { z } from "zod";
import { CairnError } from "../../errors.js";
import { nameToTitle } from "../tree.js";
export const configSchema = z.object({
    /** Docusaurus site checkout, absolute or relative to the cairn project. */
    sitePath: z.string().min(1),
    /** Docs root inside the site. Created if missing. */
    docsDir: z.string().min(1).default("docs"),
    /** Commit the project folder in the site repo after publish. Never pushes. */
    autoCommit: z.boolean().default(false),
});
export function make(config) {
    return new DocusaurusConnector(config);
}
/** "Quick Start!" → "quick-start" — filename/id form of a page title. */
export function slugify(title) {
    return title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}
const SITE_CONFIGS = ["docusaurus.config.js", "docusaurus.config.ts", "docusaurus.config.mjs"];
const FRONT_MATTER_RE = /^---\n([\s\S]*?)\n---\n/;
function frontMatter(title, version, position) {
    const quoted = `"${title.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
    const pos = position === undefined ? "" : `sidebar_position: ${position}\n`;
    // mdx.format: md — bodies cross the SPI as raw markdown, and Docusaurus v3
    // compiles .md as MDX by default, where any literal <tag> is a parse error.
    return `---\ntitle: ${quoted}\n${pos}mdx:\n  format: md\n`
        + `sidebar_custom_props:\n  cairn_version: ${version}\n---\n\n`;
}
function readFrontMatter(raw) {
    const block = FRONT_MATTER_RE.exec(raw)?.[1];
    if (!block)
        return {};
    const title = /^title:\s*"(.*)"\s*$/m.exec(block)?.[1]
        ?.replace(/\\(["\\])/g, "$1");
    const position = /^sidebar_position:\s*(\d+)\s*$/m.exec(block)?.[1];
    const version = /^\s*cairn_version:\s*(\d+)\s*$/m.exec(block)?.[1];
    return {
        title,
        position: position === undefined ? undefined : Number(position),
        version: version === undefined ? undefined : Number(version),
    };
}
export class DocusaurusConnector {
    cfg;
    capabilities = {
        hasPageTree: true, hasAttachments: false, hasLabels: false, hasNativeToc: true,
    };
    siteAbs;
    docsAbs;
    rootId;
    projectName;
    probed = false;
    constructor(cfg) {
        this.cfg = cfg;
        this.siteAbs = resolve(process.cwd(), cfg.sitePath);
        this.docsAbs = join(this.siteAbs, cfg.docsDir);
    }
    /** Sanity probe: sitePath must hold a Docusaurus site. Cached after first pass. */
    probeSite() {
        if (this.probed)
            return;
        if (!SITE_CONFIGS.some((f) => existsSync(join(this.siteAbs, f)))) {
            throw new CairnError("CONFIG_INVALID", `no docusaurus.config.{js,ts,mjs} in ${this.siteAbs}`, "point docs.config.sitePath in cairn.json at a Docusaurus site checkout");
        }
        this.probed = true;
    }
    abs(id) {
        return join(this.docsAbs, ...id.split("/"));
    }
    isDir(id) {
        return statSync(this.abs(id)).isDirectory();
    }
    readCategory(dirId) {
        const path = join(this.abs(dirId), "_category_.json");
        if (!existsSync(path))
            return undefined;
        return JSON.parse(readFileSync(path, "utf8"));
    }
    writeCategory(dirId, cat) {
        writeFileSync(join(this.abs(dirId), "_category_.json"), `${JSON.stringify(cat, null, 2)}\n`);
    }
    pageFor(id) {
        const parent = posix.dirname(id);
        const base = {
            id,
            parentId: parent === "." ? undefined : parent,
            url: this.abs(id),
        };
        if (this.isDir(id)) {
            const cat = this.readCategory(id);
            return {
                ...base,
                title: cat?.label ?? nameToTitle(posix.basename(id)),
                version: cat?.customProps?.cairn_version,
            };
        }
        const fm = readFrontMatter(readFileSync(this.abs(id), "utf8"));
        return {
            ...base,
            title: fm.title ?? nameToTitle(posix.basename(id)),
            version: fm.version,
        };
    }
    /** Sidebar order = arrival order: existing page-ish siblings + 1. */
    nextPosition(parentDirAbs) {
        const entries = readdirSync(parentDirAbs).filter((e) => !e.startsWith(".") && e !== "_category_.json" && e !== "index.md"
            && (statSync(join(parentDirAbs, e)).isDirectory() || /\.md$/i.test(e)));
        return entries.length + 1;
    }
    parentDirId(parentId) {
        return parentId ?? this.rootId ?? "";
    }
    async ensureRoot(projectName) {
        this.probeSite();
        mkdirSync(this.docsAbs, { recursive: true });
        const id = slugify(projectName);
        this.rootId = id;
        this.projectName = projectName;
        const dirAbs = this.abs(id);
        if (!existsSync(dirAbs))
            mkdirSync(dirAbs);
        if (!this.readCategory(id)) {
            this.writeCategory(id, { label: projectName, customProps: { cairn_version: 1 } });
        }
        return this.pageFor(id);
    }
    async getPage(id) {
        this.probeSite();
        if (!existsSync(this.abs(id))) {
            throw new CairnError("NOT_FOUND", `no page ${id} under ${this.docsAbs}`);
        }
        return this.pageFor(id);
    }
    async findPage(title, parentId) {
        this.probeSite();
        if (parentId !== undefined || this.rootId !== undefined) {
            const dirId = this.parentDirId(parentId);
            const hit = this.findInDir(title, dirId);
            if (hit || parentId !== undefined)
                return hit;
            // no parentId: fall through to a recursive sweep under the root
            return this.findRecursive(title, this.rootId);
        }
        return null;
    }
    findInDir(title, dirId) {
        const dirAbs = dirId === "" ? this.docsAbs : this.abs(dirId);
        if (!existsSync(dirAbs))
            return null;
        const slug = slugify(title);
        const idOf = (name) => (dirId === "" ? name : posix.join(dirId, name));
        if (existsSync(join(dirAbs, `${slug}.md`)))
            return this.pageFor(idOf(`${slug}.md`));
        if (existsSync(join(dirAbs, slug)))
            return this.pageFor(idOf(slug));
        // rename fallback: slug no longer matches the filename — match stored titles
        for (const page of this.childPages(dirId)) {
            if (page.title === title)
                return page;
        }
        return null;
    }
    findRecursive(title, dirId) {
        const hit = this.findInDir(title, dirId);
        if (hit)
            return hit;
        for (const page of this.childPages(dirId)) {
            if (this.isDir(page.id)) {
                const sub = this.findRecursive(title, page.id);
                if (sub)
                    return sub;
            }
        }
        return null;
    }
    childPages(dirId) {
        const dirAbs = dirId === "" ? this.docsAbs : this.abs(dirId);
        if (!existsSync(dirAbs))
            return [];
        return readdirSync(dirAbs)
            .filter((e) => !e.startsWith(".") && e !== "_category_.json" && e !== "index.md")
            .filter((e) => statSync(join(dirAbs, e)).isDirectory() || /\.md$/i.test(e))
            .map((e) => this.pageFor(dirId === "" ? e : posix.join(dirId, e)));
    }
    async listChildren(parentId) {
        this.probeSite();
        return this.childPages(parentId);
    }
    async createPage(spec) {
        this.probeSite();
        const dirId = this.parentDirId(spec.parentId);
        const dirAbs = dirId === "" ? this.docsAbs : this.abs(dirId);
        mkdirSync(dirAbs, { recursive: true });
        const position = this.nextPosition(dirAbs);
        if (spec.container) {
            const name = spec.sourceName ?? slugify(spec.title);
            const id = dirId === "" ? name : posix.join(dirId, name);
            mkdirSync(join(dirAbs, name), { recursive: true });
            this.writeContainer(id, spec, position, 1);
            return this.pageFor(id);
        }
        // source filename wins so repo-relative links between docs keep resolving
        const fileName = spec.sourceName ?? `${slugify(spec.title)}.md`;
        const fileId = dirId === "" ? fileName : posix.join(dirId, fileName);
        writeFileSync(join(dirAbs, fileName), frontMatter(spec.title, 1, position) + this.body(spec.markdown));
        return this.pageFor(fileId);
    }
    async updatePage(id, spec) {
        this.probeSite();
        if (!existsSync(this.abs(id))) {
            throw new CairnError("NOT_FOUND", `no page ${id} under ${this.docsAbs}`);
        }
        if (this.isDir(id)) {
            const prev = this.readCategory(id);
            const version = (prev?.customProps?.cairn_version ?? 0) + 1;
            this.writeContainer(id, spec, prev?.position, version);
            return this.pageFor(id);
        }
        const fm = readFrontMatter(readFileSync(this.abs(id), "utf8"));
        writeFileSync(this.abs(id), frontMatter(spec.title, (fm.version ?? 0) + 1, fm.position) + this.body(spec.markdown));
        return this.pageFor(id);
    }
    /**
     * Directory page: non-empty markdown → index.md landing (native category
     * index); empty markdown → a generated-index _category_.json and no index.md.
     */
    writeContainer(id, spec, position, version) {
        const empty = spec.markdown.trim() === "";
        this.writeCategory(id, {
            label: spec.title,
            ...(position === undefined ? {} : { position }),
            customProps: { cairn_version: version },
            ...(empty ? { link: { type: "generated-index" } } : {}),
        });
        const indexAbs = join(this.abs(id), "index.md");
        if (empty) {
            rmSync(indexAbs, { force: true });
        }
        else {
            writeFileSync(indexAbs, frontMatter(spec.title, version) + this.body(spec.markdown));
        }
    }
    body(markdown) {
        return markdown.endsWith("\n") || markdown === "" ? markdown : `${markdown}\n`;
    }
    async finalize() {
        if (!this.cfg.autoCommit)
            return undefined;
        if (!this.rootId || !this.projectName)
            return undefined; // nothing published
        const git = (args) => execFileSync("git", ["-C", this.siteAbs, ...args], { stdio: "pipe" });
        try {
            git(["rev-parse", "--is-inside-work-tree"]);
            git(["add", this.abs(this.rootId)]);
            git(["commit", "-m", `docs(cairn): publish ${this.projectName}`]);
            return undefined;
        }
        catch (e) {
            // nothing-to-commit exits non-zero too — a clean no-op, not a warning
            const err = e;
            const detail = [err.message, err.stdout?.toString(), err.stderr?.toString()]
                .filter(Boolean).join("\n");
            if (/nothing to commit/i.test(detail))
                return undefined;
            return `auto-commit skipped: ${detail.split("\n").find((l) => l.trim()) ?? "git failed"}`;
        }
    }
}
