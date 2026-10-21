try {
    var s = JSON.parse(localStorage.getItem("infinite-canvas:theme_store") || "{}");
    var t = s.state && s.state.theme === "light" ? "light" : "dark";
    document.documentElement.classList.toggle("dark", t === "dark");
    document.documentElement.style.colorScheme = t;
} catch (e) {}
