# Agent console

> Related decisions: [ADR-0028](../adr/0028-manage-agent-teams-from-the-local-console.md)

## Overview

The local service's pages and settings are meant for the owner alone, yet any web page could reach the computer's loopback address. Every page and API of the local service is open only to browsers that the owner authorized on this computer with a one-time login link. The console opens on the team overview, which shows how each dispatch group's agents are organized, what they are working on and where each kind of information is kept.

## Capabilities

- A local login command prints a one-time login link and opens it in the default browser; with an option it only prints the link, to paste into another browser. The link is valid for 2 minutes and works once.
- Opening the link authorizes that browser. It stays authorized across service restarts, for 400 days, renewed whenever a page opens.
- The command lists the authorized browsers with their browser and system, authorization time and last use, and revokes one of them or all. A revoked browser's open pages disconnect at once and turn into the login card with a revoked notice.
- A browser without authorization, including one opening an expired or used link, sees only a card explaining how to obtain a link. No data is shown and nothing can be changed.
- The existing settings pages and local status require the same login.
- The console's pages share one shell: a sidebar with the identity, the console pages that exist (团队总览, 团队管理 and MCP 管理, with the current page selected), the owner's private entries for Penny and the ordinary private chat, and a 「本机」 section; info tips beside titles; details in a drawer over the page; and below 900px a menu bar that opens the sidebar.
- 「本机登录」 in the 「本机」 section shows how many browsers are authorized and opens a drawer listing each one with its authorization time, last use and a current-browser marker. Each has 收回 and the list has 全部收回, both confirmed inline; revoking this browser turns the page into the login card.
- 团队总览 shows, for each dispatch group, the Coordinator, its Team Leaders and, under each leader, a dashed frame per request with that team's running or waiting Executors; ended Executors leave the tree. Each leader's card counts its requests as running, waiting or history. Teams collapse one by one, and the tree zooms and fits the window.
- Selecting any node opens its related records: each request's result, its path from the Coordinator through any cross-team parts, its Assignments with their Executor, team, profile, the Brief each Executor received, status and result, the group posts with whether the platform accepted each, the original message and links to its storage. The business outcome and the report's delivery are shown apart, and a partial failure, an interrupted Assignment or a part no team took are visible. Search and two state filters narrow the records.
- A relationships and storage tab describes each node and where its information is kept, separately for the group memory, Team Leader and Executor memories, execution records, group tasks, Penny's stores and the ordinary private chat, with links to related nodes and 返回. For a dispatch group, the group memory store shows that group's memory read-only: every entry and every dated event, including those curated before agent teams existed. Penny shows only its status and storage, never its ledger. Every text from members, agents or tools is shown as plain text.
- The Codex plugin authorizes itself through the same local channel. However many plugin processes run, they appear in the list as one entry, 「Codex 插件」, which can be revoked like a browser; after a revocation they come back as one new entry.
- Every authorization and revocation, and every saved MCP server or tool change, is recorded in a local audit file that the owner reads from the command line; it never contains a link, credential or secret value.

## Boundaries and non-goals

- Only this computer can use the service: requests addressed to any other host name are refused, including through a rebound domain name, and changes must come from the service's own pages.
- The login command needs the service to be running; otherwise it says so and prints no link.
- There is no remote access from another computer and no audit page.
