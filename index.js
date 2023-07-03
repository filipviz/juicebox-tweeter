import { Client, auth } from "twitter-api-sdk";
import express from "express";
import { config } from "dotenv";
import fs from "fs";
import session from "express-session";
import crypto from "crypto";
config();

const juicebox_subgraph = process.env.JUICEBOX_SUBGRAPH;
console.log('Juicebox Twitter server initialized.')

if (!fs.existsSync("timestamp.txt")) {
  fs.writeFileSync("timestamp.txt", Math.floor(Date.now() / 1000).toString());
  console.log("Created new timestamp.txt");
}
let timestamp = fs.readFileSync("timestamp.txt");

async function querySubgraph() {
  return fetch(juicebox_subgraph, {
    headers: { "Content-Type": "application/json" },
    method: "POST",
    body: JSON.stringify({
      query: `{
        projectCreateEvents(where:{timestamp_gt: ${timestamp}}){
          project{
            handle
            metadataUri
          }
          from
          projectId
          txHash
          pv
          timestamp
        }
      }`,
    }),
  }).then((res) => res.json());
}

async function resolveMetadata(metadataUri) {
  return fetch(`https://ipfs.io/ipfs/${metadataUri}`).then((res) => res.json());
}

async function resolveEns(address) {
  const ens = await fetch(
    `https://api.ensideas.com/ens/resolve/${address}`
  ).then((res) => res.json());
  return ens.name ? ens.name : address;
}

let authorized = false;
async function main() {
  if(!authorized){ console.log("No authorized user. Skipping project check."); return; }
  console.log("Checking for new projects");
  const json = await querySubgraph();
  for (const p of json.data.projectCreateEvents) {
    if (p.timestamp > timestamp) {
      timestamp = p.timestamp;
      console.log(`Updating most recent timestamp to ${timestamp}`);
      fs.writeFileSync("timestamp.txt", timestamp.toString());
    }
    const [metadata, from] = await Promise.all([
      resolveMetadata(p.project.metadataUri),
      resolveEns(p.from),
    ]);
    const project_name = metadata.name
      ? metadata.name
      : `v${p.pv} project ${p.projectId}`;

    const tweet = await client.tweets.createTweet({
      text: `${project_name} launched by ${from}\n\nhttps://juicebox.money/${
        p.pv === "2" ? "v2/p/" + p.projectId : "p/" + p.project.handle
      }`,
    });
    console.log("New tweet: " + JSON.stringify(tweet));
  }
}

// Check every 3 minutes.
setInterval(main, 180 * 1000);

const app = express();
app.use(
  session({
    secret: process.env.SECRET_KEY,
    resave: false,
    saveUninitialized: false,
  })
);

const authClient = new auth.OAuth2User({
  client_id: process.env.CLIENT_ID,
  client_secret: process.env.CLIENT_SECRET,
  callback: "http://localhost:3000/callback",
  scopes: ["tweet.write", "tweet.read", "users.read"],
});
const client = new Client(authClient);

app.get("/callback", async function (req, res) {
  try {
    const { code, state } = req.query;
    if (state !== req.session.oauth2state)
      return res.status(500).send("State isn't matching");
    await authClient.requestAccessToken(code);
    authorized = true;
    console.log("Successfully authorized.");
    res.send("Successfully authorized.")
  } catch (error) {
    console.log(error);
  }
});

app.get("/login", async function (req, res) {
  if (authorized) {
    return res.send('Already authorized. Please <a href="/revoke">revoke</a> first.');
  }
  const state = crypto.randomBytes(20).toString("hex");
  req.session.oauth2state = state;
  const authUrl = authClient.generateAuthURL({
    state,
    code_challenge_method: "s256",
  });
  res.redirect(authUrl);
});

app.get("/revoke", async function (_, res) {
  try {
    const response = await authClient.revokeAccessToken();
    console.log("Access token revoked.");
    authorized = false;
    res.send(response);
  } catch (error) {
    console.log(error);
  }
});

app.listen(3000, () => {
  console.log(`Go here to login: http://localhost:3000/login`);
});
