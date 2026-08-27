(() => {
  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  const reveals = document.querySelectorAll(".reveal");
  if (reveals.length) {
    if (!("IntersectionObserver" in window)) {
      reveals.forEach((el) => el.classList.add("is-in"));
    } else {
      const io = new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            if (entry.isIntersecting) {
              entry.target.classList.add("is-in");
              io.unobserve(entry.target);
            }
          }
        },
        { rootMargin: "0px 0px -12% 0px", threshold: 0.18 }
      );
      reveals.forEach((el) => io.observe(el));
    }
  }

  const frame = document.querySelector(".story-frame");
  const caption = document.getElementById("story-caption");
  const dots = [...document.querySelectorAll(".story-dot")];
  const story = document.getElementById("story");
  if (!frame || !caption || !story) return;

  const acts = [
    "A spacecraft throws a bus-voltage warn",
    "Sources slide into ORBIT",
    "ORBIT breaks the sources into a timed story",
    "A hypothesis lands — with a recommendation that is not sent",
  ];

  let act = 0;
  let timer = null;
  const dwell = [2400, 5200, 5600, 3200];

  const paint = (next) => {
    act = ((next % acts.length) + acts.length) % acts.length;
    frame.dataset.act = String(act);
    // retrigger nested CSS animations by bouncing a class
    frame.classList.remove("is-playing");
    void frame.offsetWidth;
    frame.classList.add("is-playing");

    caption.style.opacity = "0";
    window.setTimeout(() => {
      caption.textContent = acts[act];
      caption.style.opacity = "1";
    }, reduce ? 0 : 160);

    dots.forEach((dot, i) => dot.classList.toggle("is-on", i === act));
  };

  const schedule = () => {
    if (reduce || timer) return;
    const tick = () => {
      paint(act + 1);
      timer = window.setTimeout(tick, dwell[act]);
    };
    timer = window.setTimeout(tick, dwell[act]);
  };

  const stop = () => {
    if (!timer) return;
    window.clearTimeout(timer);
    timer = null;
  };

  dots.forEach((dot) => {
    dot.addEventListener("click", () => {
      stop();
      paint(Number(dot.dataset.actBtn) || 0);
      if (!reduce) schedule();
    });
  });

  paint(0);

  if (reduce) {
    caption.textContent = acts.join(" · ");
    return;
  }

  if ("IntersectionObserver" in window) {
    const storyIo = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) schedule();
          else stop();
        }
      },
      { threshold: 0.4 }
    );
    storyIo.observe(story);
  } else {
    schedule();
  }
})();
