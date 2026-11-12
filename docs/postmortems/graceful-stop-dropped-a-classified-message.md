# A graceful stop dropped a group message being classified

Date: 2026-11-12 (agent-teams ticket 47).

## Root cause

The dispatch intake treated "the service is stopping" as "this message is dealt with". A crash and a graceful stop ended its handling differently:

- **A crash** leaves the message's input row in classification. Each start queues such rows again, so the message is taken in again.
- **A graceful stop** let the intake run on to the end of the message's step, and the step marked the input completed. This happened on two paths in `processInputs` (`apps/weixin-service/src/agent-dispatch.ts` at e4306c6). The first is when the Coordinator's turn still answers after the stop began (line 551: `if (!this.eligible(...) || this.closing) finishInput`). The second is when the stop ends that turn with an error, which is the production path because the dispatch's close closes the runtime pool the Coordinator's turn runs in (the catch at lines 674–677). Either way the next start never classified the message, and its requester got no reply.

A second rule made the same loss reach posts. `deliverNotice` records any post as cancelled once the service is stopping, so a post the intake made after an await that a stop spanned was cancelled and never sent. That covered the Coordinator's reassignment notice after a mentioned team's explanation, the Coordinator's question when the team left meanwhile, and a cancel's report after the request's choices were closed. The workers already avoided this by not posting once stopping, which leaves their posts queued for the next start; the intake did not.

## Why the existing checks did not catch it

- The restart cases of the dispatch either killed the process (`running.crash()` in real-main cases) or closed the service while requests ran, waited or posted. A crash leaves a message in classification to the requeue at start, which a graceful stop never reaches, and no case stopped the service gracefully during a classification turn apart from the one engine case below.
- The one engine case with a graceful stop during a classification, "does not classify a message again for a team that left when, meanwhile, the service began to stop" (`tests/agent-dispatch.test.ts` at e4306c6, lines 2711–2730), asserted only what that instance did: no second classification and no post. No later start checked whether the message was still waiting.
- Real main had no way to hold a classification turn: the fixture classifier answered at once, so no real-main case could stop the service during one.

## Defenses

- The intake leaves a message whose classification, or whose mentioned team's explanation, a stop cut off with nothing recorded, so the next start classifies it once. Once a message's decision is recorded, a post the intake still owes stays queued for the next start. The rule is in the agent-dispatch spec, Implementation Decisions, "A stop during the intake".
- Real-main cases stop the service gracefully while a classification turn is held by the fixture-only `classificationHold`, which the dispatch's stop ends, and then start it again. They cover both stop paths, and also an explanation that was accepted as the stop began (`tests/agent-dispatch.integration.test.ts`).
- Engine cases close an instance while a cancel closes the request's choices and while the reassignment notice is posted, then start a second instance on the same store and check what it posts (`tests/agent-dispatch.test.ts`).

## Boundaries

- A message that the pending-choice handling took is not taken in again, and its reply is still cancelled when the stop came during that handling. That is agent-teams ticket 59.
- Evidence is in agent-teams ticket 47's local working records (the delivery note and the test report under `docs/.workings/agent-teams/`). They are not committed.
