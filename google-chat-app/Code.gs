const FIREBASE_PROJECT_ID = PropertiesService.getScriptProperties().getProperty("FIREBASE_PROJECT_ID") || "live-chat-5fb87";
const CHAT_SPACE = PropertiesService.getScriptProperties().getProperty("GOOGLE_CHAT_SPACE") || "";
const ALLOWED_ADMINS = (PropertiesService.getScriptProperties().getProperty("ALLOWED_ADMINS") || "ariful40807@gmail.com,fatema0063@gmail.com").split(",").map(s => s.trim().toLowerCase()).filter(Boolean);

function doGet() {
  return json_({ok:true,service:"portfolio-google-chat-bridge"});
}

function doPost(e) {
  try {
    const body = JSON.parse(e.postData.contents || "{}");
    if (body.action !== "visitor_message") return json_({ok:false,error:"Unknown action"});
    if (!body.chatId || !body.text) return json_({ok:false,error:"chatId and text are required"});
    return json_({ok:true,result:sendVisitorMessageToChat_(body)});
  } catch (err) {
    console.error(err.stack || err);
    return json_({ok:false,error:String(err.message || err)});
  }
}

function onMessage(event) {
  const email = String(event.user && event.user.email || "").toLowerCase();
  if (!ALLOWED_ADMINS.includes(email)) return {text:"This Chat app is restricted to approved admins."};
  const text = String(event.message && event.message.text || "").trim();
  if (!text) return {text:"Message received."};

  const threadName = event.thread && event.thread.name;
  if (!threadName) return {text:"Please reply inside a website visitor thread."};

  const mapping = getFirestoreDoc_("googleChatThreads", hash_(threadName));
  const chatId = mapping && mapping.fields && mapping.fields.chatId && mapping.fields.chatId.stringValue;
  if (!chatId) return {text:"This thread is not linked to a website visitor chat."};

  writeVisitorChatMessage_(chatId, text, email);
  return {text:"✓ Reply delivered to the website visitor."};
}

function sendVisitorMessageToChat_(body) {
  if (!CHAT_SPACE) throw new Error("GOOGLE_CHAT_SPACE is not configured.");

  const message = {
    text:"💬 Website Live Chat\n👤 " + safe_(body.visitorName || "Visitor") +
      "\n📧 " + safe_(body.visitorEmail || "Not provided") + "\n\n" + safe_(body.text),
    thread:{threadKey:String(body.chatId)}
  };

  const token = getGoogleAccessToken_("https://www.googleapis.com/auth/chat.bot");
  const url = "https://chat.googleapis.com/v1/" + CHAT_SPACE + "/messages";
  const response = UrlFetchApp.fetch(url,{
    method:"post",
    contentType:"application/json",
    headers:{Authorization:"Bearer " + token},
    payload:JSON.stringify(message),
    muteHttpExceptions:true
  });
  const code = response.getResponseCode(), raw = response.getContentText();
  if (code < 200 || code >= 300) throw new Error("Google Chat API " + code + ": " + raw);

  const data = JSON.parse(raw);
  const threadName = data.thread && data.thread.name;
  if (threadName) {
    setFirestoreDoc_("googleChatThreads",hash_(threadName),{
      chatId:{stringValue:String(body.chatId)},
      threadName:{stringValue:String(threadName)}
    });
  }
  return {threadName:threadName || null};
}

function writeVisitorChatMessage_(chatId,text,adminEmail) {
  const messageId = Utilities.getUuid().replace(/-/g,"");
  setFirestoreDoc_("chats/" + encodeURIComponent(chatId) + "/messages",messageId,{
    text:{stringValue:text},
    sender:{stringValue:"admin"},
    senderName:{stringValue:adminEmail},
    createdAt:{timestampValue:new Date().toISOString()}
  });
  patchFirestoreDoc_("chats",chatId,{
    updatedAt:{timestampValue:new Date().toISOString()},
    lastSender:{stringValue:"admin"},
    status:{stringValue:"open"}
  });
}

function getGoogleAccessToken_(scope) {
  const raw = PropertiesService.getScriptProperties().getProperty("CHAT_SERVICE_ACCOUNT_JSON");
  if (!raw) throw new Error("CHAT_SERVICE_ACCOUNT_JSON is missing.");
  const c = JSON.parse(raw);
  const now = Math.floor(Date.now()/1000);
  const header = base64url_(JSON.stringify({alg:"RS256",typ:"JWT"}));
  const claim = base64url_(JSON.stringify({iss:c.client_email,scope:scope,aud:"https://oauth2.googleapis.com/token",iat:now,exp:now+3600}));
  const unsigned = header + "." + claim;
  const signature = Utilities.computeRsaSha256Signature(unsigned,c.private_key);
  const jwt = unsigned + "." + base64urlBytes_(signature);

  const res = UrlFetchApp.fetch("https://oauth2.googleapis.com/token",{
    method:"post",
    payload:{grant_type:"urn:ietf:params:oauth:grant-type:jwt-bearer",assertion:jwt},
    muteHttpExceptions:true
  });
  const code = res.getResponseCode(), text = res.getContentText();
  if (code < 200 || code >= 300) throw new Error("OAuth token error " + code + ": " + text);
  return JSON.parse(text).access_token;
}

function firestoreUrl_(collectionPath,docId) {
  return "https://firestore.googleapis.com/v1/projects/" + encodeURIComponent(FIREBASE_PROJECT_ID) +
    "/databases/(default)/documents/" + collectionPath + "/" + encodeURIComponent(docId);
}

function setFirestoreDoc_(collectionPath,docId,fields) {
  const token = getGoogleAccessToken_("https://www.googleapis.com/auth/datastore");
  const res = UrlFetchApp.fetch(firestoreUrl_(collectionPath,docId),{
    method:"patch",contentType:"application/json",
    headers:{Authorization:"Bearer " + token},
    payload:JSON.stringify({fields}),muteHttpExceptions:true
  });
  const code=res.getResponseCode();
  if(code<200||code>=300)throw new Error("Firestore write "+code+": "+res.getContentText());
  return JSON.parse(res.getContentText());
}

function patchFirestoreDoc_(collectionPath,docId,fields) {
  const token=getGoogleAccessToken_("https://www.googleapis.com/auth/datastore");
  const mask=Object.keys(fields).map(k=>"updateMask.fieldPaths="+encodeURIComponent(k)).join("&");
  const res=UrlFetchApp.fetch(firestoreUrl_(collectionPath,docId)+"?"+mask,{
    method:"patch",contentType:"application/json",
    headers:{Authorization:"Bearer "+token},
    payload:JSON.stringify({fields}),muteHttpExceptions:true
  });
  const code=res.getResponseCode();
  if(code<200||code>=300)throw new Error("Firestore patch "+code+": "+res.getContentText());
  return JSON.parse(res.getContentText());
}

function getFirestoreDoc_(collectionPath,docId) {
  const token=getGoogleAccessToken_("https://www.googleapis.com/auth/datastore");
  const res=UrlFetchApp.fetch(firestoreUrl_(collectionPath,docId),{
    method:"get",headers:{Authorization:"Bearer "+token},muteHttpExceptions:true
  });
  if(res.getResponseCode()===404)return null;
  const code=res.getResponseCode();
  if(code<200||code>=300)throw new Error("Firestore read "+code+": "+res.getContentText());
  return JSON.parse(res.getContentText());
}

function hash_(value) {
  const bytes=Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256,value,Utilities.Charset.UTF_8);
  return bytes.map(b=>(b<0?b+256:b).toString(16).padStart(2,"0")).join("");
}
function base64url_(s){return base64urlBytes_(Utilities.newBlob(s).getBytes())}
function base64urlBytes_(bytes){return Utilities.base64EncodeWebSafe(bytes).replace(/=+$/,"")}
function safe_(s){return String(s).replace(/[<>]/g,"").slice(0,3000)}
function json_(obj){return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON)}
