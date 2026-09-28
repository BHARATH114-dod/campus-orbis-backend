# Campus Orbis — Multi-College Platform

## 🆕 New in this update — Clubs, Forum, Leaderboard, Analytics, Certificates, Bookmarks

This pass integrates six modules into the existing app **without touching
your role hierarchy, auth, or any existing feature**:

- **Clubs** — join/leave, member list, club update posts, and a photo
  gallery (GridFS-backed). This module didn't exist in the codebase yet
  (only leftover CSS for it did), so it was built from scratch.
- **Discussion Forum** — Q&A threads with subject filters, search, and
  likes on both threads and replies. Separate from the existing Public
  Board (complaints/opinions/lost & found), which is untouched.
- **Leaderboard** — Overall Campus / Department-wise / Section-wise
  rankings, a Hall of Fame, and badges. Computed on the fly from data
  that already exists (event RSVPs, attendance, marks, club membership)
  — no new "points" bookkeeping was threaded through other routes.
- **Dashboard analytics** — chart widgets (Chart.js, loaded from CDN)
  on Super Admin → Reports and on new "Analytics" tabs for College
  Admin and HOD.
- **Event certificates** — students who RSVP'd to a past event can
  download/print a certificate from the Events tab.
- **Study material bookmarks** — a bookmark toggle on every note, plus
  a "My Bookmarks" tab.
- **Online Tests** — faculty write their own questions — multiple-choice
  **and/or theory/long-answer** — (correct option marked for MCQ, one
  mark value per question, an optional open/close window, and a time
  limit), assign the test to one of their own sections, and every
  student in that section gets exactly one attempt. MCQ answers are
  auto-graded instantly; theory answers sit "pending" until the faculty
  member grades them from the Results screen (per-question score box,
  the total recalculates automatically). The attempt runs in **browser
  full-screen mode** — the student is asked to enter full screen when
  they click "Start test", and if they leave full screen for any reason
  (Esc, Alt+Tab, closing the window) the client force-submits whatever
  is filled in immediately and flags the submission so faculty can see
  it (`⚠ exited fullscreen`, also in the CSV export).
  **Caveat:** this is a browser-level lockdown, not a proctoring tool —
  it stops accidental/casual tab-switching and window-closing, but a
  determined student can still use a second device, and the Fullscreen
  API is inconsistently supported on some mobile browsers (iOS Safari
  in particular). Treat the flag as a signal to review, not proof.

No new npm packages were added — everything reuses `express`,
`mongodb` (including the GridFS pattern already used for note files,
event posters, and college logos), and `multer`, which were already in
`package.json`.

**Note:** the original spec doc also mentions Year-wise leaderboards.
Your student records only carry `department` and `section_id` (no
`year`/batch field), so the leaderboard ships with Campus / Department
/ Section scopes — add a `year` field to student creation if you want
that fourth scope too, and it's a small follow-up.

**Note:** the pre-existing "Marks" feature (faculty manually typing in
each student's score for an offline test) is untouched and still
labeled "+ New test" in its own tab — that's the original app's
wording, not this update. The new **Tests** tab is a separate,
auto-graded, online multiple-choice feature; the two don't share data.



Campus Orbis now matches a strict, top-down role hierarchy, with every
college's data fully isolated from every other college:

```
Super Admin  (owns the platform)
   └─ College Admin  (one per college)
        └─ HOD  (one per department)
             └─ Faculty  (in charge of one or more sections)
             └─ Student  (belongs to exactly one section)
```

**There is no public sign-up.** Every account is created by the role
directly above it — the Super Admin creates College Admins, College
Admins create HODs, and HODs create both Faculty and Students.

## What's inside

```
campus-orbis-backend/
  server.js         Express server + all API routes
  package.json      Dependencies
  public/
    start.html        Public landing page (shown before login)
    index.html         The actual app (login + dashboard)
    app_logic.js         All dashboard/app JavaScript
    app_style.css          All dashboard/app styling (unchanged green theme)
    logo.png                Your Campus Orbis crest
```

## Requirements

- [Node.js](https://nodejs.org) version 18 or newer.
- **MongoDB** — installed locally, or a free [MongoDB Atlas](https://www.mongodb.com/atlas) cluster.

## Setup

1. `npm install`
2. Point at your database (defaults to `mongodb://127.0.0.1:27017/campusync`):
   ```
   export MONGODB_URI="mongodb+srv://<user>:<password>@<cluster>/campusync"
   ```
3. Set the initial Super Admin credentials (required on first run — see
   below), then `npm start`
4. Open **http://localhost:3000**

The database is created automatically on first run. On that first run, the
server creates one **Super Admin** account from environment configuration —
it is never seeded with a hardcoded or default password:

```
export SUPER_ADMIN_USERNAME="choose-a-username"
export SUPER_ADMIN_PASSWORD="choose-a-strong-password-12-chars-minimum"
```

If these aren't set (or the password is under 12 characters) on first run,
no Super Admin account is created and the server logs instructions to set
them and restart — the password itself is never logged. Once a Super Admin
account exists, these variables are ignored on every subsequent start, and
the account can change its own password from **Profile → Change password**.

## Getting a college up and running

1. **Log in as Super Admin** with the credentials you configured above →
   **Colleges** →
   **"+ Add college"**. Give it a name, optionally upload its logo, and
   create its **College Admin** account in the same form.
2. **Log in as that College Admin** → **HODs** → **"+ Add HOD"** for each
   department (e.g. Computer Science, Mechanical).
3. **Log in as an HOD** → **Sections** to create sections (e.g. "Section
   A"), **Faculty** to add faculty members, then back in **Sections**,
   use the dropdown next to each section to assign a faculty member as
   its in-charge. Then **Students** to add students to a section.
4. **Log in as that Faculty** member → **My Students** shows their
   section's roster; **Attendance** and **Marks** let them record data
   for it.
5. **Log in as a Student** to see announcements, events, notes, and their
   own attendance/marks.

## How visibility cascades

Announcements and Notes have three posting levels:

- **College Admin** posts college-wide — everyone in the college sees it.
- **HOD** posts department-wide — everyone in that department sees it
  (their faculty and students), and so does the College Admin.
- **Faculty** posts to their own section only — their students see it,
  plus their HOD and College Admin.

A College Admin always sees everything happening in their college (every
department, every section) for oversight — but only ever *posts* at the
college-wide level themselves.

## Data isolation between colleges

Every record — users, sections, announcements, notes, events, the public
board — is tagged with a `college_id`, and every query filters by it.
Two colleges on the same running app never see each other's data. This
is **logical isolation within one shared MongoDB database**, not
physically separate database servers per college — the standard,
practical way to do this for an app like this. If you eventually want
truly separate infrastructure per college (e.g. for compliance reasons),
that's a bigger deployment change, not something built into the app
logic — ask if you want help planning that.

The only intentional bridge between colleges is **Campus Network** (see
below), and it requires an explicit request + accept between two College
Admins — nothing is visible or shared until then.

## Campus Network (only College Admins)

A College Admin can browse other colleges' admins and send a connection
request. The other admin sees it and can **Accept** or **Decline** —
nothing is shared until they accept. Once connected, they can exchange
messages, share announcements, and send event invites, all in one
conversation. Super Admin, HOD, Faculty, and Student accounts never see
or use this — it's College-Admin-to-College-Admin only, matching the
"colleges don't touch each other by default" rule.

## Notes / study material

Faculty, HODs, and College Admins can upload a file (PDF, Word,
PowerPoint, Excel, text, or an image) when sharing a note. There's a
checkbox: **"Allow students to download this file."**

- **Unchecked (default):** PDFs and images open in a view-only in-app
  viewer — the file is fetched over an authenticated connection and
  drawn onto a canvas (via PDF.js for PDFs), never as a direct link or
  download button. Office documents (Word/PowerPoint/Excel) are stored
  but the app is upfront that in-browser preview isn't available for
  those formats yet, rather than faking one.
- **Checked:** a normal download link appears instead, for any file type.

Nothing stops a screenshot of what's on screen — this is a real,
meaningful deterrent against casual downloading, not literal DRM.

## Attendance & Marks

- Faculty pick a section and date, mark each student present/absent, and
  save — one record per section per date (re-saving the same date
  overwrites it).
- Faculty can record a named test with a max score and per-student
  scores; students see only their own result.
- Students see their overall attendance percentage and a day-by-day
  history, plus a list of their test scores.

## Removing a college

A Super Admin can **disable** a college (blocks every login for that
college immediately, data stays intact) or **remove** it entirely
(deletes all of that college's users, sections, announcements, notes and
their files, events and posters, and board posts — permanent, with a
confirmation prompt).

## Account settings

Every signed-in user (any role) can change their own password from
**⚙ Account settings** in the sidebar — current password required.

## What's intentionally not included in this version

An earlier conversation also covered a leaderboard, a discussion forum,
a light/dark theme toggle, profile auto-expiry, and QR-code sharing for
board posts. None of those are in this rebuild — this version follows
the role hierarchy you specified exactly, and those extras weren't part
of that spec. Ask if you'd like any of them added back in.

## Security notes (read before using this for real student data)

- Passwords are hashed with SHA-256, not a slower salted algorithm like
  bcrypt — fine for a prototype, not for production as-is.
- Sessions last 7 days with no "log out everywhere" button, though
  changing your password signs out your other sessions automatically.
- The "view-only" notes protection is a genuine deterrent, not
  unbreakable DRM — see the Notes section above.
- Deleting a college is permanent and immediate — there's a confirmation
  prompt, but no undo.
- Right now this runs on plain HTTP on localhost. Put a real domain and
  HTTPS in front of it before using this for anyone but yourself.

If you want any of these hardened further, just ask.
