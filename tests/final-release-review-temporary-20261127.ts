// Standalone offline entry point; regression cases now live in the regular suite.
import "./framework/offlineEnvironment";
import "./cases/seasonLifecycle.test";
import "./cases/announcementPreflight.test";
import "./critical/registrationOptimisations.test";
import "./critical/identityMutationSafety.test";
import "./cases/eventIdentitySync.test";
import { runAll } from "./framework/test";

void runAll();
