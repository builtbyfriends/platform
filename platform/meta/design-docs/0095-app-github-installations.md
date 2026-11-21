---
title: GitHub App installations for an app's own spaces
status: implemented
created: 2026-11-21
---

# GitHub App installations for an app's own spaces

Background: [Build service](./0010-builds.md), [identity linking](./0074-github-deploy-identity-linking.md).

## Problem

An app on Platform can call GitHub through the proxy (`POST /github/request`). Before this,
the proxy used one stored token per project (`credentials.set`), limited to a list of repos.
An app with many spaces of its own, such as servers in a chat app, needed one shared token
and a hand-kept list. It also couldn't let each space bring its own GitHub organization.

## Design

The app's people install Platform's GitHub App on their own organization, for one of the
app's spaces. Platform keeps the App key and mints a short-lived installation token for each
call. The app never holds the key or a long-lived token.

- `project_github_installations` holds `(project_id, scope) → installation_id`. `scope` is the
  app's own id for the space (`[A-Za-z0-9_:.-]{1,128}`). It's never shared between projects.
- The app's backend calls `POST /github/app` on the proxy with `op` and `scope`. The proxy
  passes it to `POST /internal/github-app/:projectId` with its internal credential:
  - `install-url` (`returnUrl`): a signed state and the App's install link.
  - `describe` (`state` optional): the installation's account, repo selection and
    permissions, and whether it was connected under that state.
  - `repositories` (`page`): 30 repos a page.
  - `disconnect`: deletes the row. The App stays installed on GitHub.
- GitHub sends the person to `GET /github-app/callback`. It checks the state (HMAC with
  `JWT_SECRET`, `purpose: 'github-app'`, 30 minutes) and proves, with the person's own GitHub
  token from the install's `code`, that they can reach the installation. Then it stores the
  row with the state's nonce and sends the person back to `returnUrl` with `state` and
  `bound=1`, or `error`.
- `POST /github/request` with `scope` uses that installation's token and skips the stored
  repo list: GitHub limits the token to the installation's repos.

## Decisions

- A state from another GitHub flow goes on to `/github/callback` unchanged. GitHub sends
  each install to the App's first callback URL, so one App serves managed builds and apps.
- `returnUrl` isn't checked against the project's hosts. Only the project's own backend can
  mint a state, through the proxy, so it can only send its own people back to itself.
- The app compares `describe`'s `matched` with the state it started, so a person who didn't
  start the connection can't finish it for them.

## Setup

The App needs "Request user authorization (OAuth) during installation" turned on,
`<api>/github-app/callback` as its first callback URL, and Contents, Pull requests and
Metadata permissions for apps that open pull requests. The API Worker needs
`GITHUB_APP_ID`, `GITHUB_APP_SLUG`, `GITHUB_APP_PRIVATE_KEY`, `GITHUB_APP_CLIENT_ID` and
`GITHUB_APP_CLIENT_SECRET`.
