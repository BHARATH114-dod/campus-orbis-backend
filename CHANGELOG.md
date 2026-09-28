# Campus Orbis — Update Log

All changes below are also marked inline in the code with `UPDATED:` comments,
so you can search for that word in any file to find exactly what changed.

## 1. Mandatory "select your college" step
- **New public API:** `GET /api/public/colleges` (`server.js`) — lists every
  active college (name + logo) with no login required.
- **New first screen** on the login page (`index.html` / `app_logic.js`):
  before anyone can see a login form, they must search for and pick their
  college from a list, styled after the reference screenshot you sent
  (search box + clickable list of colleges with their logos).
- **Server-side enforcement** (`server.js`, `/api/auth/login`): every role
  except Super Admin must now send the `college_id` that was picked, and the
  server checks the account actually belongs to that college. A student from
  College A can no longer log in while College B is "selected."

## 2. Redesigned login page (two-panel layout)
- Rebuilt to match the reference image: a form panel on the left, and a
  branded visual panel on the right.
- **Your logo (`/logo.png`) replaces the parrot photo** in the right-hand
  panel, on a gradient background with the tagline "One Platform. Every
  Campus."
- The role tabs (Student / Faculty / HOD / College Admin) now appear only
  after a college has been picked, directly above the sign-in form.
- A "← Change college" link lets someone go back and pick a different
  college without reloading the page.

## 3. Super Admin moved to the start page
- The start page (`start.html`) now has a **"Super Admin" button** in the
  top navigation, right next to "Login."
- It links to `/index.html#admin`, which skips the college picker entirely
  (the platform owner isn't tied to any one college) and goes straight to a
  dedicated Super Admin sign-in screen.
- A "Platform Super Admin? Sign in here" link is also available at the
  bottom of the regular college-select screen, as a second way in.

## 4. Light mode / dark mode
- A **toggle button** (🌙 / ☀️) now appears:
  - On the start page, in the top nav.
  - On the login page, top-right corner.
  - Inside **Account settings** (for signed-in users), under a new
    "Appearance" section with Light / Dark buttons.
- The choice is saved (`localStorage`) and shared across the start page,
  login page, and the app — pick it once and it stays.
- Applied via CSS variables in `app_style.css`, so the whole app (sidebar,
  cards, tables, forms, modals) follows the theme, not just the login page.

## 5. Simplified, clearer start page
- Nav trimmed to the essentials: theme toggle, Super Admin, Login.
- Same color palette as before (so the brand stays recognizable) but with a
  dark-mode variant added throughout.

## Files touched
- `server.js` — new public colleges endpoint; login now requires/validates a
  college for tenant roles.
- `public/index.html` — new two-panel auth shell markup; theme applied
  before first paint.
- `public/app_logic.js` — new college-select stage, restructured login
  stage, Super Admin portal flow, theme toggle logic, Appearance section in
  Account settings.
- `public/app_style.css` — new two-panel login / college-select styles,
  dark-mode variables, and a `--surface-dark` variable so brand-dark
  surfaces (sidebar, footer, badges) don't invert in dark mode.
- `public/start.html` — Super Admin button, theme toggle, dark-mode
  variables.

## Not changed
- `logo.png` is used as-is (the crest/logo already in the project) — replace
  this file with a different image any time and it will automatically show
  up on the start page, login page, and sidebar.
- All existing dashboard features (attendance, marks, clubs, forum,
  leaderboard, tests, etc.) are untouched — only the login/auth flow, start
  page nav, and theming changed.

## 6. Clubs — Maximum Members, join codes, and a live Kahoot-style Club Quiz
- **Club creation now requires a Maximum Members count and a Club Leader.**
  The leader isn't auto-enrolled — a join code is generated instead, visible
  only to the faculty who created the club. Faculty hands that code to the
  chosen student offline.
- **Code-gated join flow** (`POST /api/clubs/join-by-code`): the designated
  student enters the code to activate the club and become Club Leader
  (`leader_confirmed: true`); the code then becomes visible to them too
  (`can_see_code`), and they can share it further. Any student entering it
  after activation joins as a regular member — the Maximum Members limit is
  enforced server-side (`"Club is full. Maximum member limit has been
  reached."`).
- **Leadership transfer** (`POST /api/clubs/:id/transfer-leader`): the
  current leader (or a manager) hands the role to another existing member.
  There is always exactly one active leader.
- **New Club Quiz module** — faculty author a quiz (questions, 2–6 options
  each, correct answer, a per-question timer up to 60s, and points per
  question) under `POST /api/clubs/:id/quizzes`; a separate quiz code
  (`POST /api/club-quizzes/join`) gates participation to that club's roster.
- **Kahoot-style live play**: `POST /api/club-quizzes/:id/start` begins the
  quiz; `GET /api/club-quizzes/:id/session` is polled by both host and
  players and drives the whole experience — live countdown, automatic
  advance to the next question when time runs out, a Top 5 shown between
  questions, and a Final Top 10 at the end (with the player's own rank shown
  underneath if they're outside it). All timing, correctness, and scoring
  are computed from the server clock and the server-held answer key — never
  trusted from the client.
- **Time-based scoring**: a correct answer scores between 50% and 100% of
  that question's max points depending on how quickly it was submitted; a
  wrong or missed answer scores 0.
- **Club Leaderboard** (`GET /api/clubs/:id/quiz-leaderboard`) — points
  earned across that club's quizzes only, kept entirely separate from
  `GET /api/leaderboard` (the normal academic Campus Orbis leaderboard).
- Frontend: `Clubs.jsx` gained a "Have a club code?" entry point, a code
  display + leadership controls on the club's Members tab, a new Quizzes
  tab (create/join/host), a new Leaderboard tab, and a full-screen
  `LiveQuizView` for hosting/playing a live quiz.


## Saved Test / Reusable Question Paper feature
- **New collection:** `saved_tests` (`server.js`) — a reusable question-paper
  template, completely independent of `tests`/`test_submissions`. No
  cascade-delete relationship exists between the two in either direction.
- **New faculty API:**
  - `POST /api/faculty/saved-tests` — "Save Test". Either snapshots an
    already-conducted test (`{ source_test_id }`) or saves straight from the
    create-test form (`{ title, subject, description, duration_minutes,
    questions }`). Supports an optional `client_token` so an accidental
    double-click can't create two templates for the same save.
  - `GET /api/faculty/saved-tests` — list the faculty member's saved tests
    (title, question count, total marks, duration, created/updated dates).
  - `GET /api/faculty/saved-tests/:id` — full detail (for Edit / Use Again).
  - `PUT /api/faculty/saved-tests/:id` — edit the template only; any
    Conducted Test already created from it is completely unaffected.
  - `DELETE /api/faculty/saved-tests/:id` — deletes the template only;
    existing Conducted Tests, submissions, and results are untouched.
- **Frontend (`FacultyTests.jsx`):** a "Saved Tests" button next to "+ New
  test", a "💾 Save Test" action on every conducted-test card and on the
  create/preview test form, and a Saved Tests modal (Use Again / Edit /
  Delete, with a confirmation dialog before delete and an empty state).
  "Use Again" opens the same create-test form prefilled with the saved
  question paper, subject, and duration — the faculty member still picks a
  fresh section, date/time, and other scheduling before publishing a brand
  new Conducted Test. Existing test creation, grading, monitoring, and
  submission behaviour are unchanged.
