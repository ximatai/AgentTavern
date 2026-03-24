function App() {
  return (
    <main
      style={{
        minHeight: "100vh",
        display: "grid",
        placeItems: "center",
        background:
          "radial-gradient(circle at top, #f3ead8 0%, #e4d5b7 45%, #d5c29d 100%)",
        color: "#2f2418",
        fontFamily: "Georgia, serif",
      }}
    >
      <section
        style={{
          width: "min(720px, calc(100vw - 32px))",
          padding: "32px",
          borderRadius: "20px",
          background: "rgba(255, 248, 235, 0.82)",
          boxShadow: "0 24px 80px rgba(59, 39, 18, 0.18)",
          border: "1px solid rgba(100, 72, 38, 0.14)",
        }}
      >
        <p style={{ margin: 0, letterSpacing: "0.12em", fontSize: "0.75rem" }}>
          AGENT TAVERN
        </p>
        <h1 style={{ margin: "12px 0 8px", fontSize: "2.75rem" }}>
          Room-first human and agent collaboration.
        </h1>
        <p style={{ margin: 0, fontSize: "1.05rem", lineHeight: 1.7 }}>
          Web shell bootstrapped. Next step is wiring room state, realtime events,
          and local agent execution.
        </p>
      </section>
    </main>
  );
}

export default App;

