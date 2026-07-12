import { trackerContract } from "./contract.js";
import { FakeTracker } from "../src/tracker/fake.js";

trackerContract("fake", async () => new FakeTracker());
