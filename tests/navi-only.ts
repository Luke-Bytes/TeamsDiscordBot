import "./framework/offlineEnvironment";
import "./cases/aiAssistant.test";
import "./cases/aiAskImprovements.test";
import "./cases/aiAnswerQuality.test";
import "./cases/aiPerformanceShortlist.test";
import "./cases/aiHttpRetry.test";
import "./cases/aiHistoricalState.test";
import "./cases/aiKnowledgeQc.test";
import "./cases/naviPrompt.test";
import { runAll } from "./framework/test";

// Targeted offline AI suite; no unmocked network or production services.
void runAll();
