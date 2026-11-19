// Burns Notice settings.
// The Firebase web config below is meant to be public. Who can see what is
// controlled by the database rules (firestore.rules), not by hiding this file.

export const firebaseConfig = {
  apiKey: "AIzaSyDrB1kolnPqc4qV7owT-CeU46SjaD7zEyk",
  authDomain: "burns-notice.firebaseapp.com",
  projectId: "burns-notice",
  storageBucket: "burns-notice.firebasestorage.app",
  messagingSenderId: "463678797900",
  appId: "1:463678797900:web:1b3102475ff9cf8eff1ce9"
};

export const PROPERTY = "Burns Street";
export const UNITS = ["Unit 1", "Unit 2", "Unit 3", "Unit 4"];

// The landlord's account. Change this (and the same ID in firestore.rules)
// when the real landlord account replaces the test one.
export const LANDLORD_UID = "YDnotZgOyhUrCRk6kjU6YsJoHOE3";

// Which account lives in which unit. To swap a test account for a real
// tenant, replace the ID here AND in firestore.rules, then upload both.
export const TENANTS = {
  "0P2nLXFGFhb47YHRCX3VTiGQ6Gj1": { unit: "Unit 1", name: "Unit 1 tenant" },
  "dErM3Hr4pzXfCZLRGZ7rSmOxb132": { unit: "Unit 2", name: "Unit 2 tenant" },
  "8sG9ReOArjM05fKht786ANPaXXr1": { unit: "Unit 3", name: "Unit 3 tenant" },
  "NgtyonXT2of5cfX9Optxkpyoplv2": { unit: "Unit 4", name: "Unit 4 tenant" }
};
