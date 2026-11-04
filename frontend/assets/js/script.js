document.addEventListener("DOMContentLoaded", () => {

  /* =========================
     MOBILE MENU
  ========================== */

  const menuBtn = document.getElementById("menuBtn");
  const navLinks = document.getElementById("navLinks");

  if (menuBtn && navLinks) {

    menuBtn.addEventListener("click", () => {
      navLinks.classList.toggle("active");
    });

    document.querySelectorAll(".nav-links a").forEach((link) => {

      link.addEventListener("click", () => {
        navLinks.classList.remove("active");
      });

    });

  }


  /* =========================
     LOAD CATEGORIES FROM API
  ========================== */

  const servicesGrid =
    document.getElementById("servicesGrid");

  const serviceSelect =
    document.getElementById("service");


  fetch("http://localhost:5000/api/categories")

    .then((response) => {

      if (!response.ok) {
        throw new Error("Failed to fetch categories");
      }

      return response.json();

    })

    .then((data) => {

      if (
        !data.success ||
        !Array.isArray(data.categories)
      ) {
        throw new Error("Invalid categories response");
      }


      /* =========================
         SERVICE ICONS
      ========================== */

      const icons = {

        "wedding-photos": "💍",

        "photo-frames": "🖼️",

        "photo-albums": "📖",

        "customized-gifts": "🎁",

        "family-photoshoot": "👨‍👩‍👧",

        "passport-photos": "🪪"

      };


      /* =========================
         SERVICES SECTION
      ========================== */

      if (servicesGrid) {

        servicesGrid.innerHTML =
          data.categories
            .map((category) => {

              return `
                <article class="service-card reveal">

                  <div class="service-icon">
                    ${icons[category.slug] || "📸"}
                  </div>

                  <h3>
                    ${category.name}
                  </h3>

                  <p>
                    ${category.description || ""}
                  </p>

                </article>
              `;

            })
            .join("");


        servicesGrid
          .querySelectorAll(".reveal")
          .forEach((element) => {

            element.classList.add("visible");

          });

      }


      /* =========================
         ENQUIRY SERVICE DROPDOWN
      ========================== */

      if (serviceSelect) {

        serviceSelect.innerHTML = `

          <option value="">
            Service निवडा
          </option>

          ${data.categories
            .map((category) => {

              return `
                <option value="${category.name}">
                  ${category.name}
                </option>
              `;

            })
            .join("")}

        `;

      }

    })

    .catch((error) => {

      console.error(
        "Failed to load categories:",
        error
      );


      if (servicesGrid) {

        servicesGrid.innerHTML = `
          <p>
            Services load nahi ho paayi.
          </p>
        `;

      }


      if (serviceSelect) {

        serviceSelect.innerHTML = `
          <option value="">
            Services unavailable
          </option>
        `;

      }

    });


  /* =========================
     SCROLL REVEAL
  ========================== */

  const revealElements =
    document.querySelectorAll(".reveal");


  if ("IntersectionObserver" in window) {

    const revealObserver =
      new IntersectionObserver(

        (entries, observer) => {

          entries.forEach((entry) => {

            if (entry.isIntersecting) {

              entry.target.classList.add("visible");

              observer.unobserve(entry.target);

            }

          });

        },

        {
          threshold: 0.12
        }

      );


    revealElements.forEach((element) => {

      revealObserver.observe(element);

    });

  } else {

    revealElements.forEach((element) => {

      element.classList.add("visible");

    });

  }


  /* =========================
     GALLERY LIGHTBOX
  ========================== */

  const lightbox =
    document.getElementById("lightbox");

  const lightboxImage =
    document.getElementById("lightboxImage");

  const lightboxClose =
    document.getElementById("lightboxClose");

  const galleryItems =
    document.querySelectorAll(".gallery-item");


  function closeLightbox() {

    if (!lightbox || !lightboxImage) {
      return;
    }

    lightbox.classList.remove("active");

    lightboxImage.src = "";

  }


  galleryItems.forEach((item) => {

    item.addEventListener("click", () => {

      if (!lightbox || !lightboxImage) {
        return;
      }


      const image =
        item.getAttribute("data-image");


      if (!image) {
        return;
      }


      lightboxImage.src = image;

      lightbox.classList.add("active");

    });

  });


  if (lightboxClose) {

    lightboxClose.addEventListener(
      "click",
      closeLightbox
    );

  }


  if (lightbox) {

    lightbox.addEventListener(
      "click",
      (event) => {

        if (event.target === lightbox) {
          closeLightbox();
        }

      }
    );

  }


  document.addEventListener(
    "keydown",
    (event) => {

      if (event.key === "Escape") {
        closeLightbox();
      }

    }
  );


  /* =========================
     WHATSAPP + DATABASE ENQUIRY
  ========================== */

  const enquiryForm =
    document.getElementById("enquiryForm");


  if (enquiryForm) {

    enquiryForm.addEventListener(
      "submit",
      async (event) => {

        event.preventDefault();


        const name =
          document
            .getElementById("name")
            ?.value.trim() || "";


        const mobile =
          document
            .getElementById("mobile")
            ?.value.trim() || "";


        const service =
          document
            .getElementById("service")
            ?.value || "";


        const date =
          document
            .getElementById("date")
            ?.value || "";


        const requirement =
          document
            .getElementById("requirement")
            ?.value.trim() || "";


        const message =
          document
            .getElementById("message")
            ?.value.trim() || "";


        /* =========================
           BASIC VALIDATION
        ========================== */

        if (!name || !mobile) {

          alert(
            "Please enter your name and mobile number."
          );

          return;

        }


        try {

          /* =========================
             SAVE ENQUIRY TO DATABASE
          ========================== */

          const response =
            await fetch(
              "http://localhost:5000/api/enquiries",
              {

                method: "POST",

                headers: {
                  "Content-Type": "application/json"
                },

                body: JSON.stringify({

                  name: name,

                  mobile: mobile,

                  service: service,

                  date: date,

                  requirement: requirement,

                  message: message

                })

              }
            );


          const data =
            await response.json();


          if (!response.ok || !data.success) {

            throw new Error(
              data.message ||
              "Failed to save enquiry"
            );

          }


          console.log(
            "Enquiry saved successfully:",
            data.enquiry
          );


          /* =========================
             WHATSAPP MESSAGE
          ========================== */

          const whatsappMessage =
`नमस्कार श्री फोटो स्टुडिओ,

मला तुमच्या सेवांबद्दल enquiry करायची आहे.

नाव: ${name}
Mobile: ${mobile}
Service: ${service || "Not specified"}
Preferred Date: ${date || "Not specified"}
Requirement: ${requirement || "Not specified"}

Message:
${message || "No additional message."}`;


          const whatsappURL =
            "https://wa.me/918010823556?text=" +
            encodeURIComponent(
              whatsappMessage
            );


          /* =========================
             OPEN WHATSAPP
          ========================== */

          window.open(
            whatsappURL,
            "_blank",
            "noopener,noreferrer"
          );


          /* =========================
             RESET FORM
          ========================== */

          enquiryForm.reset();


          alert(
            "Enquiry successfully saved! WhatsApp opening..."
          );


        } catch (error) {

          console.error(
            "Enquiry submission failed:",
            error
          );


          alert(
            "Enquiry save nahi ho paayi. Please try again."
          );

        }

      }
    );

  }

});