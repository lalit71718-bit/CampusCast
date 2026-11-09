import { redirect } from "next/navigation";
import Nav from "../Nav";
import AuthForm from "./AuthForm";
import { getUser } from "../../lib/supabase/server";
import { isSupabaseConfigured } from "../../lib/supabase/config";

export default async function AuthPage({ mode, title, sub, defaultEmail, notice }) {
  if (await getUser()) redirect("/");
  return (
    <>
      <Nav />
      <main className="auth">
        <div className="container">
          <div className="auth-card">
            <p className="eyebrow">{mode === "signup" ? "Early access" : "Welcome back"}</p>
            <h1 className="display">{title}</h1>
            <p className="auth-sub">{sub}</p>
            {!isSupabaseConfigured && (
              <p className="form-msg">Sign-in isn&apos;t set up yet. Add your Supabase keys to .env.local (see .env.example).</p>
            )}
            <AuthForm mode={mode} defaultEmail={defaultEmail} notice={notice} />
          </div>
        </div>
      </main>
    </>
  );
}
