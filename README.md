# bb-plugin-grill

Turns a round of grilling questions into a single form in the thread composer
instead of a wall of numbered questions in chat.

While an agent runs the grilling skill, it calls the `grill_round` tool with
the whole round: each question's prose, its recommended answer, and the
discrete alternatives. BB replaces the composer with this plugin's form and
blocks the tool until you answer or dismiss it. Every recommendation is
pre-selected on mount, so agreeing with all of it is one click on **Submit**;
each question also offers "Something else…" for an answer in your own words.
Dismissing tells the agent to fall back to asking in plain chat.

`server.ts` is the tool and its schema; `app.tsx` registers the form as a
`pendingInteraction` slot. `components/ui/` is vendored source you own.

## Install

```
npm install
bb plugin install .
bb plugin reload grill   # after editing sources
```
