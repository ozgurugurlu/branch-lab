import Link from "next/link";

export default function NotFound() {
  return (
    <main className="recovery-page">
      <span className="eyebrow">BRANCHLAB / 404</span>
      <h1>This page is not in your laboratory.</h1>
      <p>Return to the workspace to find your saved simulations.</p>
      <Link className="button primary" href="/">
        Open laboratory
      </Link>
    </main>
  );
}
