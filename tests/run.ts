// Simple test runner that executes all test cases in sequence
import "./cases/captainNominate.test";
import "./cases/basicCommands.test";
import "./cases/e2eHappyPath.test";
import "./cases/captainPlanDM.test";
import "./cases/timeBased.test";
import "./cases/snakeDraftTeams.test";
import "./cases/nicknameCommand.test";
import "./critical/mvpCritical.test";
import "./critical/classbanCritical.test";
import "./critical/captainNominateCritical.test";
import "./critical/registerCritical.test";
import "./critical/resetFlowCritical.test";
import "./critical/schedulerCancelCritical.test";
import "./critical/twoConsecutiveGames.test";
import "./critical/lateSignupDraft.test";
import "./critical/systemEdgeCases.test";
import "./critical/punishmentExpiry.test";
import "./critical/randomTeams.test";
import "./critical/eloBalanceTeams.test";
import "./critical/teamPlanCapture.test";
import "./critical/sharedBansDefault.test";
import "./critical/classBanModes.test";
import "./cases/ignsCommand.test";
import "./cases/timestampChoices.test";
import { runAll } from "./framework/test";

runAll();
