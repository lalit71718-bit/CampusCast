import Link from "next/link";
import { BadgeCheck } from "lucide-react";
import { createClient, getUser } from "../lib/supabase/server";
import { getProfile } from "../lib/profile";
import { signOut } from "../app/auth/actions";

export default async function Nav() {
  const user = await getUser();
  let profile = null;
  if (user) ({ profile } = await getProfile(await createClient(), user.id));
  const name = (profile?.full_name || user?.user_metadata?.full_name)?.split(" ")[0] || user?.email;
  const verified = profile?.status === "verified";

  return (
    <header className="nav" id="nav">
      <div className="container nav-in">
        <Link href="/" className="logo">Campus<i>Cast</i></Link>
        <nav className="nav-links" aria-label="Primary">
          <Link href="/#how">How it works</Link>
          <Link href="/#try">Try the filters</Link>
          <Link href="/#features">Features</Link>
          <Link href="/#roadmap">Roadmap</Link>
        </nav>
        {user ? (
          <div className="nav-auth">
            {verified ? (
              <span className="nav-user" title={user.email}>
                <BadgeCheck size={16} aria-label="Verified" /> {name}
              </span>
            ) : (
              <Link href="/verify" className="nav-signin">
                {profile?.status === "pending" ? "ID under review" : "Verify your ID"}
              </Link>
            )}
            <form action={signOut}>
              <button type="submit" className="pill-sm">Sign out</button>
            </form>
          </div>
        ) : (
          <div className="nav-auth">
            <Link href="/signin" className="nav-signin">Sign in</Link>
            <Link href="/signup" className="pill-sm">Sign up</Link>
          </div>
        )}
      </div>
    </header>
  );
}
