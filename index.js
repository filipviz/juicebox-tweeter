import { config } from "dotenv";
import { Client, auth } from "twitter-api-sdk";
import express from "express";
import fs from "fs";
import session from "express-session";
import crypto from "crypto";
import { createPublicClient, http, parseAbiItem } from "viem";
import { mainnet } from "viem/chains";
import twitter from "twitter-text";
import TurndownService from "turndown";

config();

BigInt.prototype.toJSON = function () {
  return this.toString();
};
console.log("Juicebox Twitter server initializing.");

const publicClient = createPublicClient({
  transport: http(),
  chain: mainnet,
});

const turndownService = new TurndownService();
turndownService.addRule('removeImages', {
  filter: ['img'],
  replacement: () => ''
})

if (!fs.existsSync("fromBlock.txt")) {
  const block = await publicClient.getBlock();
  fs.writeFileSync("fromBlock.txt", block.number.toString());
  console.log("Created new fromBlock.txt");
}
let fromBlock = BigInt(fs.readFileSync("fromBlock.txt"))

const JBProjects = "0xD8B4359143eda5B2d763E127Ed27c77addBc47d3";
const getNewProjects = () => {
  console.log(`Fetching from ${fromBlock}`)
  return publicClient.getLogs({
    address: JBProjects,
    event: parseAbiItem(
      "event Create(uint256 indexed projectId, address indexed owner, (string content, uint256 domain) metadata, address caller)"
    ),
    fromBlock,
  });
}

// await getNewProjects().then((p) =>
//   p.forEach((g) => console.log(g))
// );

async function resolveMetadata(metadataUri) {
  return fetch(`https://ipfs.io/ipfs/${metadataUri}`).then((res) => res.json());
}

let authorized = false;
async function main() {
  if (!authorized) {
    console.log("No authorized user. Skipping project check.");
    return;
  }
  console.log("Checking for new projects");
  const logs = await getNewProjects();

  for (const l of logs) {
    if (l.blockNumber >= fromBlock) {
      fromBlock = l.blockNumber + 1n;
      console.log(`Updating most recent creation block to ${fromBlock}`);
      fs.writeFileSync("fromBlock.txt", fromBlock.toString());
    }
    const metadata = await resolveMetadata(l.args.metadata.content);
    const project_name = metadata.name
      ? metadata.name
      : `Project ${l.args.projectId.toString()}`;
    const url = `https://juicebox.money/v2/p/${l.args.projectId.toString()}`;
    const tag = metadata.twitter ? `\nby @${metadata.twitter}` : "";

    let constructedTweet = `New project: ${project_name}${tag}\nLink: ${url}`;

    // 280 max tweet length
    const description_length =
      280 - twitter.parseTweet(constructedTweet).weightedLength;
    if (metadata.description)
      constructedTweet += "\n\n" + turndownService
        .turndown(metadata.description)
        .replace(/\n\s*/g, "\n")
        .slice(0, description_length - 4) + "…"

    const tweet = await client.tweets.createTweet({
      text: constructedTweet,
    }).catch(e => console.error(JSON.stringify(e)));
    console.log("New tweet: " + JSON.stringify(tweet));
  }
}

// Check every 3 minutes.
setInterval(main, 300 * 1000);

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
  callback: `${process.env.MAIN_URL}/callback`,
  scopes: ["tweet.write", "tweet.read", "users.read"],
});
const client = new Client(authClient);

app.get("/", async function (_, res) {
  res.redirect("/login");
});

app.get("/callback", async function (req, res) {
  try {
    const { code, state } = req.query;
    if (state !== req.session.oauth2state)
      return res.status(500).send("State isn't matching");
    await authClient.requestAccessToken(code);
    authorized = true;
    console.log("Successfully authorized.");
    res.send("Successfully authorized.");
  } catch (error) {
    console.log(error);
  }
});

app.get("/login", async function (req, res) {
  if (authorized) {
    return res.send(
      'Already authorized. Please <a href="/revoke">revoke</a> first.'
    );
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
  console.log(`Go here to login: ${process.env.MAIN_URL}/login`);
});
