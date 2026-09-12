/**
 * Purpose: the seat-finding dedup engine — N seats over one target
 * collapse to ONE finding set before anything reaches the tracker (the
 * phase's hard requirement). Pure library, no tool surface: review and
 * audit are agent-side verbs, so the coordinator calls this via node
 * against dist when it needs the reference merge, and the server consumes
 * it in future pipelines — same precedent as composeBrief in brief.ts.
 * Dependency-free and deterministic on purpose: shuffled input, same
 * output, every time.
 * Author(s): John Reed
 */


// Constants

// Two findings merge only when they sit on the same file within this many
// lines of the cluster's anchor (its lowest-line member). ±2 catches the
// "same bug, seat quoted the line above/below" case without gluing
// together genuinely separate findings further apart.
export const LINE_WINDOW = 2;

// Claim similarity floor: normalized-token Jaccard overlap
// (|intersection| / |union|) must reach this for two claims to count as
// the same finding. 0.5 means the claims share at least as many tokens
// as they differ by — paraphrases of one bug clear it, distinct claims
// about the same location don't. Exact normalized match short-circuits.
export const CLAIM_SIMILARITY_THRESHOLD = 0.5;

// Highest severity first — a merged finding keeps the worst rating any
// seat gave it. Rank = index into this list.
export const SEVERITIES = ["critical", "important", "minor"] as const;


// Types

export type Severity = (typeof SEVERITIES)[number];

/** One seat's raw finding, exactly as the seat raised it. */
export interface SeatFinding {
  /** Name of the seat that raised it (e.g. "security"). */
  seat: string;
  /** File the finding points at. */
  file: string;
  /** 1-based line the finding points at. */
  line: number;
  /** The claim — what's wrong, in the seat's words. */
  claim: string;
  severity: Severity;
  /** The seat's anchored 0-10 score for its walk, when it gave one. */
  score?: number;
}

/** One seat's credit on a merged finding — name plus its own score. */
export interface SeatCredit {
  seat: string;
  score?: number;
}

/** One deduplicated finding, crediting every seat that raised it. */
export interface DedupedFinding {
  file: string;
  /** Lowest line among the merged findings (the cluster anchor). */
  line: number;
  /** Canonical claim — from the highest-severity raising finding. */
  claim: string;
  /** Highest severity any raising seat assigned. */
  severity: Severity;
  /** Every raising seat, sorted by name, each with its own score. */
  seats: SeatCredit[];
}


// Claim normalization + similarity

/**
 * Lowercases and collapses every non-alphanumeric run to a single space —
 * the normalized form two claims are compared in.
 *
 * :param claim: raw claim text
 * :returns: normalized claim string
 */
function normalizeClaim(claim: string): string {
  return claim.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

/**
 * Token-set Jaccard similarity between two normalized claims, with an
 * exact-match fast path. Deterministic, dependency-free.
 *
 * :param aNorm: first normalized claim
 * :param aSet: its token set
 * :param bNorm: second normalized claim
 * :param bSet: its token set
 * :returns: true when the claims describe the same finding
 */
function claimsMatch(
  aNorm: string,
  aSet: Set<string>,
  bNorm: string,
  bSet: Set<string>,
): boolean {
  // Exact fast path — identical normalized text is the same claim, no
  // set math needed.
  if (aNorm === bNorm) return true;
  if (aSet.size === 0 || bSet.size === 0) return false;

  let intersection = 0;
  for (const token of aSet) {
    if (bSet.has(token)) intersection++;
  }
  const union = aSet.size + bSet.size - intersection;
  return intersection / union >= CLAIM_SIMILARITY_THRESHOLD;
}


// Internals

interface Member {
  finding: SeatFinding;
  norm: string;
  tokens: Set<string>;
}

interface Cluster {
  file: string;
  /** Anchor = the first (lowest-line) member; the window hangs off it. */
  anchorLine: number;
  anchorNorm: string;
  anchorTokens: Set<string>;
  members: Member[];
}

/**
 * Rank of a severity — lower is worse (critical = 0).
 *
 * :param s: severity label
 * :returns: index into SEVERITIES
 */
function severityRank(s: Severity): number {
  return SEVERITIES.indexOf(s);
}


// Main

/**
 * Collapses N seats' findings over one target into one finding set.
 *
 * Merge rule (documented here, tested in test/dedup.test.ts): two
 * findings merge when they name the SAME file, sit within LINE_WINDOW
 * (±2) lines of the cluster's anchor — its lowest-line member — and
 * their claims match: exact normalized text, or normalized-token Jaccard
 * overlap at or above CLAIM_SIMILARITY_THRESHOLD (0.5). Distinct claims
 * at the same location stay separate findings.
 *
 * A merged finding credits every raising seat (`seats`, sorted by name,
 * one entry per seat with that seat's own score attributed), keeps the
 * HIGHEST severity any seat assigned, anchors at the lowest merged line,
 * and carries the claim of the highest-severity raising finding.
 *
 * Deterministic: input is sorted (file, line, severity, seat, claim)
 * before clustering, so shuffled input yields byte-identical output.
 * Output order is (file, line, severity, claim).
 *
 * :param findings: raw per-seat findings, any order
 * :returns: the deduplicated finding set, deterministically ordered
 */
export function dedupFindings(findings: SeatFinding[]): DedupedFinding[] {
  // Sort first — clustering order is what makes the greedy pass
  // deterministic under shuffled input.
  const sorted = [...findings].sort((a, b) =>
    a.file.localeCompare(b.file) ||
    a.line - b.line ||
    severityRank(a.severity) - severityRank(b.severity) ||
    a.seat.localeCompare(b.seat) ||
    a.claim.localeCompare(b.claim),
  );

  // Greedy anchored clustering: each finding joins the first cluster
  // whose anchor it matches, else starts its own. Anchoring the window
  // to the lowest-line member keeps chains from drifting (10 and 12
  // merge; 14 does not ride along on 12's coattails).
  const clusters: Cluster[] = [];

  for (const finding of sorted) {
    const norm = normalizeClaim(finding.claim);
    const tokens = new Set(norm.split(" ").filter(Boolean));
    const member: Member = { finding, norm, tokens };

    const home = clusters.find((c) =>
      c.file === finding.file &&
      Math.abs(finding.line - c.anchorLine) <= LINE_WINDOW &&
      claimsMatch(c.anchorNorm, c.anchorTokens, norm, tokens),
    );

    if (home) {
      home.members.push(member);
    } else {
      clusters.push({
        file: finding.file,
        anchorLine: finding.line,
        anchorNorm: norm,
        anchorTokens: tokens,
        members: [member],
      });
    }
  }

  // Fold each cluster into one finding.
  const out: DedupedFinding[] = clusters.map((cluster) => {
    // Members arrive in (line, severity, seat, claim) order — the first
    // member at the best (lowest) severity rank owns the canonical claim.
    const bestRank = Math.min(
      ...cluster.members.map((m) => severityRank(m.finding.severity)),
    );
    const canonical = cluster.members.find(
      (m) => severityRank(m.finding.severity) === bestRank,
    )!;

    // One credit per seat; a seat that raised it twice keeps the score
    // from its first (highest-severity, per sort) instance.
    const credits = new Map<string, SeatCredit>();
    for (const m of [...cluster.members].sort((a, b) =>
      severityRank(a.finding.severity) - severityRank(b.finding.severity),
    )) {
      if (!credits.has(m.finding.seat)) {
        credits.set(m.finding.seat, {
          seat: m.finding.seat,
          ...(m.finding.score !== undefined ? { score: m.finding.score } : {}),
        });
      }
    }

    return {
      file: cluster.file,
      line: cluster.anchorLine,
      claim: canonical.finding.claim,
      severity: SEVERITIES[bestRank],
      seats: [...credits.values()].sort((a, b) => a.seat.localeCompare(b.seat)),
    };
  });

  // Deterministic output order: file, line, severity, claim.
  out.sort((a, b) =>
    a.file.localeCompare(b.file) ||
    a.line - b.line ||
    severityRank(a.severity) - severityRank(b.severity) ||
    a.claim.localeCompare(b.claim),
  );

  return out;
}
