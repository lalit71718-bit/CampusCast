"use server";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { createClient } from "../../lib/supabase/server";

const NOT_CONFIGURED = "Sign-in isn't set up yet. Add your Supabase keys to .env.local.";

function readCredentials(formData) {
  const email = String(formData.get("email") || "").trim().toLowerCase();
  const password = String(formData.get("password") || "");
  return { email, password };
}

export async function signUp(_prev, formData) {
  const { email, password } = readCredentials(formData);
  const name = String(formData.get("name") || "").trim();
  if (!name) return { error: "Please enter your name.", email, name };
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { error: "Please enter a valid email address.", email, name };
  if (password.length < 8) return { error: "Use at least 8 characters for your password.", email, name };

  const supabase = await createClient();
  if (!supabase) return { error: NOT_CONFIGURED, email, name };

  const origin = (await headers()).get("origin");
  const { data, error } = await supabase.auth.signUp({
    email,
    password,
    options: { data: { full_name: name }, emailRedirectTo: `${origin}/auth/callback` },
  });
  if (error) return { error: error.message, email, name };

  // Email confirmation is turned off in Supabase: the user is signed in straight away.
  if (data.session) redirect("/");
  return { ok: `We sent a confirmation link to ${email}. Open it to finish signing up.` };
}

export async function signIn(_prev, formData) {
  const { email, password } = readCredentials(formData);
  if (!email || !password) return { error: "Enter your email and password.", email };

  const supabase = await createClient();
  if (!supabase) return { error: NOT_CONFIGURED, email };

  const { error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) {
    const msg = error.code === "email_not_confirmed"
      ? "Please confirm your email first. Check your inbox for the link."
      : "That email and password don't match.";
    return { error: msg, email };
  }
  redirect("/");
}

export async function signOut() {
  const supabase = await createClient();
  if (supabase) await supabase.auth.signOut();
  redirect("/");
}
