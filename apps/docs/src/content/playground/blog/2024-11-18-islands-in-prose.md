---
title: Islands in your prose
date: '2024-11-18'
author: Grace Hopper
tags: [islands, guide]
summary: A post is just content — so a live island can sit right in the middle of a paragraph, shipping only its own JS.
---

A blog post ships as static HTML. Where you want interactivity, you drop an **island** — and only that component's JavaScript loads.

## Why it matters

Most of a blog is text. Paying to hydrate the whole page to run one widget is the waste islands remove. The prose stays HTML; the island wakes on its own schedule.
