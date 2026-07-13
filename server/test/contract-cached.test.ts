import { trackerContract } from "./contract.js";
import { CachedTracker } from "../src/tracker/cached.js";
import { FakeTracker } from "../src/tracker/fake.js";

trackerContract("cached(fake)", async () => new CachedTracker(new FakeTracker()));
