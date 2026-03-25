let currentView = "reddit";

function switchView(view){
  currentView = view;

  document.getElementById("redditControls").classList.toggle("hidden", view !== "reddit");
  document.getElementById("twitterControls").classList.toggle("hidden", view !== "twitter");

  document.getElementById("feed").innerHTML = "";
}

function runSearch(){
  if(currentView === "reddit") fetchReddit();
  if(currentView === "twitter") fetchTwitter();
}

function formatNumber(n){
  if(n>=1e6) return (n/1e6).toFixed(1)+"M";
  if(n>=1e3) return (n/1e3).toFixed(1)+"k";
  return n;
}

function timeAgo(date){
  const ts = new Date(date).getTime()/1000;
  const diff = Date.now()/1000 - ts;

  const h = diff/3600;
  const d = diff/86400;

  if(d>=1) return Math.floor(d)+"d";
  if(h>=1) return Math.floor(h)+"h";
  return Math.floor(diff/60)+"m";
}