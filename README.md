# CampusCast

**Smart campus announcements: one feed, filtered for you.**

Students miss important updates because information is scattered across WhatsApp groups, notice boards and email. CampusCast is a single platform that filters every announcement by **department, year, club and urgency**, and bundles the student-life tools that usually live in separate chats.

This repository contains the CampusCast landing page.

## What the page covers

- **The problem and the idea:** why notices get lost, and how "publish once, reach the right students" works
- **Live filter demo:** pick a department, year and clubs and watch the notices that are not yours fade out
- **Urgency system:** P0 (critical) to P3 (FYI), and how loudly each one notifies
- **Nine sections**
  - Hackathon
  - Department Notifications
  - Examinations
  - Workshops
  - Cultural Events
  - Connect (find teammates for a hackathon)
  - Notes & Previous Papers
  - CampusXchange (seniors sell old stuff to juniors)
  - Free Mentorship
- **Trust and safety, roadmap and six-month targets**, plus an early-access signup form

## Design

A campus notice-board look: crumpled beige paper background, sticky-note cards with bold ink outlines, hard shadows, tape and pins, and hollow (outlined) lettering for emphasis. The only animation is a soft fade-in as sections scroll into view.

Fonts: Archivo Black (headings), Schibsted Grotesk (body) and DM Mono (labels, tags and numbers), loaded with `next/font`.

## Tech stack

- Next.js (App Router) and React
- GSAP with ScrollTrigger for the scroll fade-in
- lucide-react for icons
- Supabase Auth (via `@supabase/ssr`) for sign-up and sign-in
- Plain CSS, no UI framework

## Getting started

Requires Node.js 20 or newer.

```bash
npm install
npm run dev
```

Open http://localhost:3000.

Production build:

```bash
npm run build
npm start
```

## Sign-up and sign-in (Supabase)

Accounts are handled by [Supabase Auth](https://supabase.com/docs/guides/auth). Until keys are added, the site still runs and the sign-in pages say they are not set up yet.

1. Create a project at [supabase.com](https://supabase.com).
2. Copy `.env.example` to `.env.local` and fill in the Project URL and the anon (or publishable) key from **Project Settings > API**.
3. In **Authentication > URL Configuration**, set the Site URL to your site, and add `http://localhost:3000/auth/callback` (plus your production `/auth/callback` URL) to the Redirect URLs.
4. In **SQL Editor**, paste and run [`supabase/setup.sql`](supabase/setup.sql). It adds the college-email rule, the `profiles` table and the private `id-cards` storage bucket.
5. Restart `npm run dev`.

### Forgot password

"Forgot password?" on the sign-in page goes to `/forgot-password`. Students enter their college email, Supabase emails them a one-time code, and they type the code and their new password on the same page. This works on any device.

**One-time setup:** in Supabase open **Authentication > Emails > Templates > Reset Password**, set the subject to "Your CampusCast password reset code" and paste [`supabase/email-templates/reset-password.html`](supabase/email-templates/reset-password.html) as the message body. It shows the code (`{{ .Token }}`). The emailed link also still works if opened in the same browser; it goes through `/auth/callback` to `/reset-password`.

### College emails and student verification

- Sign-up only accepts college emails: `@bmsit.in`, plus domains ending in `.edu`, `.edu.<country>` or `.ac.<country>` (e.g. `iitb.ac.in`).
- BMSIT student emails are read automatically. `25ug1byai282@bmsit.in` means batch 2025, undergraduate, college code 1BY, branch `ai` (AI & Machine Learning), roll 282, so USN `1BY25AI282`. The branch is filled in and locked, the year of study is worked out from the batch (it can still be changed, e.g. for lateral entry), and batch and USN are saved on the profile. Branch codes live in `lib/college.js` (`cs` Computer Science & Engineering, `cv` Civil, `ai` AI & ML, plus the other VTU codes). For a college that uses another domain, add it in the SQL Editor: `insert into public.allowed_college_domains (domain) values ('mycollege.in');`. The rule is enforced inside Supabase, so it can't be bypassed by calling the API directly.
- After confirming their email, students land on `/verify` and enter full name, branch and year, and upload photos of their student ID card (front required, back optional).
- To review: open **Table Editor > profiles**, filter `status = pending`, view the card in **Storage > id-cards > (user id)**, then set `status` to `verified`, or to `rejected` with a `review_note` the student will see.

Pages: `/signup` and `/signin`. By default Supabase emails a confirmation link before the first sign-in; turn off **Confirm email** under **Authentication > Providers > Email** to sign users in straight after sign-up.

## Adding your video

The hero shows a video placeholder. To use your own video:

1. Put the file in `public/`, for example `public/campus-video.mp4`.
2. In `components/Hero.js`, set `VIDEO_SRC = "/campus-video.mp4"` (and optionally `VIDEO_POSTER`).

## Project structure

```
app/            layout, global styles, page, /signin, /signup, auth actions
components/     one file per page section, plus auth/ for the sign-in forms
lib/data.js     all page copy and demo data
lib/supabase/   Supabase client and config
proxy.js        refreshes the Supabase session on each request
public/         paper texture and static assets
```

## Notes

- The early-access form at the bottom of the page opens sign-up with the email filled in.
- The notices in the filter demo are sample data.
