# Agent console

> Related decisions: [ADR-0028](../adr/0028-manage-agent-teams-from-the-local-console.md)

## Overview

The local service's pages and settings are meant for the owner alone, yet any web page could reach the computer's loopback address. Every page and API of the local service is open only to browsers that the owner authorized on this computer with a one-time login link.

## Capabilities

- A local login command prints a one-time login link and opens it in the default browser; with an option it only prints the link, to paste into another browser. The link is valid for 2 minutes and works once.
- Opening the link authorizes that browser. It stays authorized across service restarts, for 400 days, renewed whenever a page opens.
- The command lists the authorized browsers with their browser and system, authorization time and last use, and revokes one of them or all. A revoked browser's open pages disconnect at once and turn into the login card with a revoked notice.
- A browser without authorization, including one opening an expired or used link, sees only a card explaining how to obtain a link. No data is shown and nothing can be changed.
- The existing settings pages and local status require the same login.
- The console's pages share one shell: a sidebar with the identity and the console pages that exist (today 团队管理 and MCP 管理, with the current page selected), info tips beside titles, details in a drawer over the page, and below 900px a menu bar that opens the sidebar.
- The Codex plugin authorizes itself through the same local channel. However many plugin processes run, they appear in the list as one entry, 「Codex 插件」, which can be revoked like a browser; after a revocation they come back as one new entry.
- Every authorization and revocation, and every saved MCP server or tool change, is recorded in a local audit file that the owner reads from the command line; it never contains a link, credential or secret value.

## Boundaries and non-goals

- Only this computer can use the service: requests addressed to any other host name are refused, including through a rebound domain name, and changes must come from the service's own pages.
- The login command needs the service to be running; otherwise it says so and prints no link.
- There is no remote access from another computer and no audit page.
