---
"ogygia": minor
---

**Breaking:** a `render: 'deferred'` hole's timing is the new `fetch` key (`with { render: 'deferred', fetch: 'visible' }`); pairing it with `wake` fails the build with the line to write, and `wake` now only means when an island's JS runs.
