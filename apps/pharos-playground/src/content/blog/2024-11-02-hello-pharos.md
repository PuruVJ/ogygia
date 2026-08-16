---
title: Hello, ogygia
date: '2024-11-02'
author: Ada Lovelace
tags: [announcement, ogygia]
summary: Introducing the ogygia docs kit — a batteries-included shell for content sites on ogygia's islands.
---

Welcome to the **ogygia** blog. This whole page is a content entry rendered through the blog shell: a dated header, the author, tags, and this body — all from one markdown file.

The blog is a separate *genre* from the docs: a flat, dated corpus with `date`, `author`, and `tags` fields, ordered newest-first.

```ts
export const blog = content({ loader: /* … */, schema: fields.post });
```

Islands work in a post exactly as they do in a doc — the body is a region, so anything interactive wakes right here in the prose.
