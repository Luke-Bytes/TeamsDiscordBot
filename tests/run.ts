// Simple test runner that executes all test cases in sequence
import "./cases/captainNominate.test";
import "./cases/basicCommands.test";
import "./cases/e2eHappyPath.test";
import "./cases/timeBased.test";
import "./critical/mvpCritical.test";
import "./critical/classbanCritical.test";
import "./critical/captainNominateCritical.test";
import "./critical/registerCritical.test";
import { runAll } from "./framework/test";

runAll();
