import { ArrowRight } from "lucide-react";

export default function CTA() {
  const z = { position: "relative", zIndex: 2 };
  return (
    <>
      <section className="cta" id="join">
        <div className="container">
          <div className="cta-card" data-reveal>
            <p className="eyebrow" style={z}>Early access</p>
            <h2 className="display" style={z}>Issue no. 1 starts when your campus <em>joins</em>.</h2>
            <p style={z}>Be part of the pilot. Bring your department, your club, and your group chats.</p>
            {/* Plain GET form: carries the email over to the sign-up page. */}
            <form className="form" action="/signup">
              <input type="email" name="email" required placeholder="25ug1byai282@bmsit.in" aria-label="College email" />
              <button className="btn" type="submit">Join the pilot <ArrowRight size={16} /></button>
            </form>
            <small>College emails only. No likes. No feed noise.</small>
          </div>
        </div>
      </section>
      <footer>
        <div className="container foot">
          <span className="logo">Campus<i>Cast</i></span>
          <span>One feed, filtered for you.</span>
          <span>© 2026 CampusCast</span>
        </div>
      </footer>
    </>
  );
}
