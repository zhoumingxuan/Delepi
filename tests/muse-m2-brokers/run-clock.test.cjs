'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadSource } = require('./fixture.cjs');
const START = Date.parse('2030-01-01T00:00:00.000Z');
async function virtual(options = {}) {
  const { createRunClock } = await loadSource('src/main/modules/budget/run-clock.ts');
  let mono = 0, wall = START, next = 1;
  const scheduled = new Map(), timers = { setTimeout(callback, milliseconds) { const id = next++; scheduled.set(id, { at: mono + milliseconds, callback }); return id; }, clearTimeout(id) { scheduled.delete(id); } };
  const clock = createRunClock({ activeMilliseconds: 100, deadlineAt: new Date(START + 1000).toISOString(), monotonicNow: () => mono, wallNow: () => wall, timers, ...options });
  const advance = (milliseconds, wallDelta = milliseconds) => {
    const finalMono = mono + milliseconds, finalWall = wall + wallDelta, oldMono = mono, oldWall = wall;
    for (;;) {
      const due = [...scheduled.entries()].filter(([, item]) => item.at <= finalMono).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      mono = due[1].at; wall = oldWall + (milliseconds ? (mono - oldMono) * wallDelta / milliseconds : wallDelta); scheduled.delete(due[0]); due[1].callback();
    }
    mono = finalMono; wall = finalWall;
  };
  return { clock, advance, scheduled, setWall: value => { wall = value; }, setMonotonic: value => { mono = value; } };
}
test('active elapsed is the union of concurrent work branches and pauses only after every branch waits for the user', async () => {
  const f = await virtual(); f.clock.registerBranch('branch-1'); f.advance(20); f.clock.registerBranch('branch-2'); f.advance(20);
  assert.equal(f.clock.snapshot().activeUsedMilliseconds, 40); // overlap is not double-charged
  f.clock.setBranchState('branch-1', 'waiting-user'); f.advance(20); assert.equal(f.clock.snapshot().activeUsedMilliseconds, 60);
  f.clock.setBranchState('branch-2', 'waiting-user'); f.advance(100); assert.equal(f.clock.snapshot().activeUsedMilliseconds, 60);
  assert.equal(f.clock.remainingMilliseconds(), 840); // inactive waits obey the absolute deadline
  f.clock.setBranchState('branch-1', 'active'); assert.equal(f.clock.remainingMilliseconds(), 40);
  f.advance(39); assert.equal(f.clock.signal.aborted, false); f.advance(1); assert.equal(f.clock.signal.aborted, true);
  assert.equal(f.clock.signal.reason.code, 'ACTIVE_TIME_EXHAUSTED'); assert.equal(f.scheduled.size, 0);
  f.clock.setBranchState('branch-1', 'settled'); f.clock.setBranchState('branch-2', 'settled'); assert.equal(f.clock.snapshot().branches.active, 0);
});
test('absolute deadline never pauses or renews while all branches wait, and aborts without another admission', async () => {
  const f = await virtual({ deadlineAt: new Date(START + 200).toISOString() }); f.clock.registerBranch('pending-approval'); f.advance(25); f.clock.setBranchState('pending-approval', 'waiting-user');
  f.advance(174); assert.equal(f.clock.signal.aborted, false); f.advance(1); assert.equal(f.clock.signal.aborted, true);
  assert.equal(f.clock.signal.reason.code, 'ABSOLUTE_DEADLINE_EXCEEDED'); assert.equal(f.clock.snapshot().activeUsedMilliseconds, 25);
  assert.equal(f.clock.remainingMilliseconds(), 0); assert.throws(() => f.clock.assertRemaining(), /ABSOLUTE_DEADLINE_EXCEEDED/);
});
test('clock uses the immutable bound deadline when created later, and cannot extend it with wall-clock rollback', async () => {
  const f = await virtual({ wallNow: () => START + 900, deadlineAt: new Date(START + 1000).toISOString() });
  assert.equal(f.clock.remainingMilliseconds(), 100); f.advance(99); assert.equal(f.clock.signal.aborted, false); f.advance(1); assert.equal(f.clock.signal.reason.code, 'ABSOLUTE_DEADLINE_EXCEEDED');
  const rolled = await virtual({ activeMilliseconds: 2000 }); rolled.clock.registerBranch('branch'); rolled.advance(100); rolled.setWall(START - 10000);
  rolled.advance(899); assert.equal(rolled.clock.signal.aborted, false); rolled.advance(1); assert.equal(rolled.clock.signal.reason.code, 'ABSOLUTE_DEADLINE_EXCEEDED');
});
test('a forward wall jump is sampled by a real scheduled callback, even with no executing branches', async () => {
  const f = await virtual({ activeMilliseconds: 10000, deadlineAt: new Date(START + 10000).toISOString() });
  f.clock.registerBranch('waiting'); f.clock.setBranchState('waiting', 'waiting-user'); f.setWall(START + 20000); f.advance(1000, 0);
  assert.equal(f.clock.signal.reason.code, 'ABSOLUTE_DEADLINE_EXCEEDED'); assert.equal(f.clock.snapshot().activeUsedMilliseconds, 0);
});
test('settled branches cannot revive or duplicate, invalid clocks fail closed, and cleanup does not restart timers', async () => {
  const f = await virtual(); f.clock.registerBranch('branch'); assert.throws(() => f.clock.registerBranch('branch'), /CLOCK_BRANCH_EXISTS/);
  assert.throws(() => f.clock.setBranchState('unknown', 'active'), /CLOCK_BRANCH_NOT_FOUND/); assert.throws(() => f.clock.setBranchState('branch', 'waiting-network'), /CLOCK_INVALID/);
  f.advance(10); f.clock.setBranchState('branch', 'settled'); assert.throws(() => f.clock.setBranchState('branch', 'active'), /CLOCK_BRANCH_SETTLED/); f.advance(50); assert.equal(f.clock.snapshot().activeUsedMilliseconds, 10);
  f.clock.dispose(); f.clock.dispose(); assert.equal(f.clock.signal.reason.code, 'CLOCK_DISPOSED'); assert.equal(f.scheduled.size, 0); assert.equal(f.clock.snapshot().state, 'disposed');
  assert.throws(() => f.clock.registerBranch('new'), /CLOCK_DISPOSED/);
  const reversed = await virtual(); reversed.clock.registerBranch('branch'); reversed.advance(10); reversed.clock.snapshot(); reversed.setMonotonic(5);
  assert.throws(() => reversed.clock.assertRemaining(), /CLOCK_INVALID/); assert.equal(reversed.scheduled.size, 0);
  const { createRunClock } = await loadSource('src/main/modules/budget/run-clock.ts');
  for (const options of [{ activeMilliseconds: 0 }, { activeMilliseconds: NaN }, { activeMilliseconds: 1.5 }, { deadlineAt: '2030-01-01' }, { deadlineAt: '2030-02-31T00:00:00.000Z' }]) assert.throws(() => createRunClock({ activeMilliseconds: 100, deadlineAt: '2030-01-01T00:00:00.000Z', ...options }), /CLOCK_INVALID/);
});
test('external stop preserves the first reason, disposes its timer and cannot reset active accounting', async () => {
  const f = await virtual(); f.clock.registerBranch('branch'); f.advance(20); f.clock.stop('USER_STOPPED'); f.clock.stop('OTHER_REASON'); f.advance(10000);
  assert.equal(f.clock.signal.reason.code, 'USER_STOPPED'); assert.equal(f.clock.snapshot().activeUsedMilliseconds, 20); assert.equal(f.scheduled.size, 0);
  f.clock.setBranchState('branch', 'settled'); assert.throws(() => f.clock.registerBranch('new'), /USER_STOPPED/);
});
test('real timers abort idle waiting and active work without a follow-up call', async t => {
  const { createRunClock } = await loadSource('src/main/modules/budget/run-clock.ts');
  const active = createRunClock({ activeMilliseconds: 35, deadlineAt: new Date(Date.now() + 1000).toISOString() });
  const waiting = createRunClock({ activeMilliseconds: 35, deadlineAt: new Date(Date.now() + 70).toISOString() });
  t.after(() => { active.dispose(); waiting.dispose(); }); active.registerBranch('active'); waiting.registerBranch('waiting'); waiting.setBranchState('waiting', 'waiting-user');
  await new Promise(resolve => setTimeout(resolve, 120));
  assert.equal(active.signal.aborted, true); assert.equal(active.signal.reason.code, 'ACTIVE_TIME_EXHAUSTED');
  assert.equal(waiting.signal.aborted, true); assert.equal(waiting.signal.reason.code, 'ABSOLUTE_DEADLINE_EXCEEDED');
  assert.ok(waiting.snapshot().activeUsedMilliseconds < 10);
});
