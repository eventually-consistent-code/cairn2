import { docsConnectorContract } from "./docs-contract.js";
import { FakeDocsConnector } from "../src/docs/fake.js";

// One shared instance per suite run would leak state between tests; the
// contract takes a factory, but several contract tests build on pages made by
// ensureRoot in the same connector — a fresh connector per test is correct
// because every test creates what it needs.
docsConnectorContract("fake", () => new FakeDocsConnector());
