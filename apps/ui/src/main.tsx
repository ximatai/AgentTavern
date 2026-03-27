import React from "react";
import ReactDOM from "react-dom/client";

import App from "./App";
// Apply theme CSS vars synchronously before React renders to prevent flash
import "./stores/settings";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
