# Privacy policy — Freelap → intervals.icu Sprint Sync

**Last updated:** 29 August 2026 · **Contact:** privacy@example.com *(replace before launch)*

This app takes sprint sessions you recorded with a Freelap timing system and writes them into your
own intervals.icu account. It exists to move your data from one place you control to another.

## What we hold, and why

| Data | Why we have it | How long we keep it |
|---|---|---|
| Your email address | To sign you in and tie your data to you | Until you delete your account |
| Your intervals.icu access and refresh tokens | To write sessions to your account, and only when you ask | Until you disconnect or delete your account |
| Your MyFreelap email and password (optional) | To fetch your sessions on your behalf. Only if you choose to store them; CSV upload works without them | Until you disconnect — deletion is immediate |
| Sprint sessions you import (times, splits, distances, timestamps) | To match them to an activity, write them, and verify what was written | Until you delete the session or your account |
| A record of which session was written to which activity | So a re-sync updates rather than duplicates, and so we can tell you when something has drifted | Until you delete your account |
| An audit record of every write we make to intervals.icu | So you and we can see exactly what this app did on your behalf | Kept after account deletion, with you no longer named |

We do not sell your data, share it with advertisers, or use it to train anything. No analytics or
tracking scripts are served.

## How credentials are protected

- Every credential is encrypted before it reaches the database, with a key of its own that is in
  turn encrypted by a master key held by a key management service. The database never sees a
  password or token in the clear.
- Credentials are never written to logs, and are redacted if an object holding one is printed.
- Master keys can be rotated without you re-entering anything.
- All traffic to intervals.icu and MyFreelap uses TLS.

## What we ask intervals.icu for

Only two OAuth scopes: `ACTIVITY:READ`, to find the activity your session belongs to, and
`ACTIVITY:WRITE`, to add intervals, summary fields and a description block to it. We do not ask for
access to your calendar, wellness, or anything else. The exact scopes are shown before you connect.

## MyFreelap

MyFreelap publishes no official API. If you choose to store your MyFreelap login, this app signs in
as you to read your own sessions — nothing else. This is unofficial: it may stop working at any
time, and if it does the app tells you and falls back to CSV upload. Fetching happens only when you
ask; there is no background polling. You can delete your stored login at any moment, and it is
deleted immediately rather than marked deleted.

## Your control

- **Disconnect** either account at any time. The stored credentials are deleted, not deactivated.
- **Delete your account** from the connections panel. Your sessions, sync history, verification
  history and credentials are removed. The audit record of past writes is kept without your
  identity, so we can answer questions about what the app did.
- Anything already written to your intervals.icu account stays there. It is yours, in your account,
  and deleting your account here does not touch it.

## Changes

If this policy changes in a way that affects what we do with your data, you will be asked to review
it before the change takes effect.
