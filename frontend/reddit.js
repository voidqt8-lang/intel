function format(n){
  if(n>=1000) return (n/1000).toFixed(1)+"k";
  return n;
}

function timeAgo(ts){
  const diff = Date.now()/1000 - ts;
  const h = diff/3600;

  if(h>=24) return Math.floor(h/24)+"d";
  if(h>=1) return Math.floor(h)+"h";
  return Math.floor(diff/60)+"m";
}

function getImage(p){
  return p.preview?.images?.[0]?.source?.url?.replaceAll("&amp;","&")
    || (p.thumbnail?.startsWith("http") ? p.thumbnail : null);
}

async function fetchPosts(){

  const sub = document.getElementById("sub").value || "memes";

  const r = await fetch(`/reddit/${sub}/hot`);
  const data = await r.json();

  const el = document.getElementById("feed");

  el.innerHTML = data.posts.map(p => {

    const img = getImage(p);

    return `
      <div class="border p-3">

        <div class="text-xs text-yellow-400">
          ⬆ ${format(p.upvotes)} • ${timeAgo(p.createdUtc)}
        </div>

        <a href="${p.url}" target="_blank">${p.title}</a>

        ${img ? `<img src="${img}" class="mt-2 max-h-60"/>` : ""}

      </div>
    `;
  }).join("");
}