import type Database from 'better-sqlite3';
import { createGoalService } from './goals/goal-service';
import { createPermissionAuthority } from './permissions/authority';
import { setLegacyPolicyReader } from './permissions/legacy-admission';
import type { TaskService } from './tasks/task-service';
import type { DestinationReader } from './goals/goal-service';
import { createBudgetLedger } from './budget/ledger';
import { DEFAULT_PUBLIC_BUDGET_CAPS } from './budget/contracts';
import { readBudgetProjection } from './budget/projection';
import { createFileBroker, reconcilePublicWrites } from './brokers/file-broker';
import { createArtifactBroker } from './brokers/artifact-broker';
import { createFetchBroker } from './brokers/fetch-broker';
import { createModelBroker } from './brokers/model-broker';
import { BrokerError } from './brokers/contracts';
import { brokerScope } from './brokers/scope';
import { createPublicInbox } from './exploration/public-inbox';
import { createExplorationService, type ExplorationService } from './exploration/exploration-service';
import { createBackgroundScheduler } from './background/scheduler';
import { createLearningService } from './learning/learning-service';
import type { BackgroundRuntimePort } from './background/background-ipc';

export function createAutonomyRuntime(db:Database.Database, taskService:TaskService, config:DestinationReader, wake:()=>void,
  roots:{publicRoot:string;artifactRoot:string}) {
  let authority:ReturnType<typeof createPermissionAuthority>;
  let exploration:ExplorationService;
  let ready=false;
  const learning=createLearningService(db,{wake});
  const ledger=createBudgetLedger(db,{caps:DEFAULT_PUBLIC_BUDGET_CAPS});
  const goals=createGoalService(db,{taskService,config,onScopeChanged:id=>{authority.cancelGoalOperations(id);exploration?.cancelGoal(id);}});
  authority=createPermissionAuthority(db,{taskService,budget:ledger,resolveDestination:id=>goals.resolveDestination(id),wake});
  const fileBroker=createFileBroker(db,{publicRoot:roots.publicRoot});
  const artifactBroker=createArtifactBroker(db,{artifactRoot:roots.artifactRoot});
  const publicInbox=createPublicInbox(db,{taskService,goalService:goals,canAppend:context=>exploration.canAppend(context),isAtSafePoint:context=>exploration.isAtSafePoint(context)});
  const fetchBroker=createFetchBroker(db,{registerSnapshot:fileBroker.registerSnapshot});
  const modelBroker=createModelBroker(db,{resolveDestination:goals.resolveDestination,verifyDocument:fileBroker.verifyDocument,
    learningContext(goalId,goalRevision){
      const scheduled=db.prepare('SELECT rule_id FROM muse_background_schedules WHERE goal_id=? AND goal_revision=? AND enabled=1 AND learning_enabled=1 AND blocked_reason IS NULL AND expires_at>?').get(goalId,goalRevision,new Date().toISOString()) as {rule_id:string}|undefined;
      if(!scheduled)return;
      try {authority.assertStandingRule(scheduled.rule_id);}catch{return;}
      const context=learning.promptForGoal(goalId,goalRevision);
      return context?{instruction:context,skills:''}:undefined;
    },
    verifyAddition(session,addition){if(!publicInbox.verifyAddition(addition,session.context,brokerScope(db,session).destination.id))throw new BrokerError('PUBLIC_ADDITION_NOT_MINTED');}});
  exploration=createExplorationService(db,{taskService,goals,authority,fetchBroker,fileBroker,modelBroker,artifactBroker,publicInbox,wake});
  const scheduler=createBackgroundScheduler(db,{goals,authority,exploration,taskService,learning,wake,
    foregroundBusy:()=>!!db.prepare("SELECT 1 FROM runs r LEFT JOIN muse_background_triggers t ON t.run_id=r.id WHERE r.state IN ('running','stop_requested') AND t.run_id IS NULL LIMIT 1").get()});
  const background:BackgroundRuntimePort={ready:()=>ready,list:scheduler.list,configure:scheduler.configure,
    setEnabled:scheduler.setEnabled,runNow:scheduler.runNow,listSkills:learning.list,rollbackSkill:learning.rollback};
  setLegacyPolicyReader(()=>authority.getPolicy());
  const unsubscribe=config.onModelConfigurationChanged?.(()=>{
    exploration.cancelAll();
    authority.cancelAllPublicOperations();
    try {goals.listDestinations();} finally {wake();}
  });
  return {goals,authority,ledger,exploration,learning,scheduler,background,
    get explorationReady(){return ready;},
    get stages(){return ready?{
      budget:(goalId?:string,runId?:string)=>readBudgetProjection(db,goalId,runId),
      planExploration:exploration.planExploration,startExploration:exploration.startExploration,
      stopExploration:exploration.stopExploration,listExplorations:exploration.listExplorations,
      appendPublicMessage:exploration.appendPublicMessage,
    }:undefined;},
    async reconcilePublicState(){
      taskService.reconcileInterrupted();authority.reconcileInterrupted();exploration.reconcileInterrupted();
      scheduler.reconcileInterrupted();
      return await reconcilePublicWrites(db,{publicRoots:[roots.publicRoot,roots.artifactRoot]});
    },
    completeStartup(){if(ready)return;ready=true;scheduler.start();},
    async dispose(){ready=false;unsubscribe?.();await scheduler.dispose();await exploration.dispose();authority.dispose();},
  };
}
