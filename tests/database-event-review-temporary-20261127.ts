// Standalone offline review runner. The regression tests themselves now live
// in the normal test suite, rather than asserting the old broken behaviour.
import "./framework/offlineEnvironment";
import "./cases/eventReconciliation.test";
import "./cases/eventIdentitySync.test";
import "./critical/punishmentExpiry.test";
import "./cases/punishExpungeCommand.test";
import "./critical/singleUseOperations.test";
import { runAll } from "./framework/test";

void runAll();
