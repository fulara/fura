import "./style.css";
import "./mobile.css";
import "highlight.js/styles/github-dark.css";
import { createFuraConnection } from "./connection";
import { mountMobileApp } from "./mobileApp";

mountMobileApp({
  document,
  window,
  createConnection: createFuraConnection,
});
