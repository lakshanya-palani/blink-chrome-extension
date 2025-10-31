// options.js - Settings manager for Blink themes, categories, and notifications

const DEFAULT_SETTINGS = {
  // Theme settings
  theme: {
    mode: 'dark',
    custom: {
      bgColor: '#2b6cb0',
      accentColor: '#38a169',
      textColor: '#ffffff'
    },
    fontStyle: "'Segoe UI', system-ui, sans-serif"
  },
  // Category settings (from existing)
  categoryMap: {
    "social": ["youtube.com", "instagram.com", "twitter.com", "tiktok.com", "facebook.com", "reddit.com"],
    "games": ["roblox.com", "steampowered.com", "epicgames.com", "miniclip.com"],
    "school": ["classroom.google.com", "canvas.instructure.com", "google.com/drive", "docs.google.com"],
    "productive": ["notion.so", "github.com", "stackoverflow.com", "drive.google.com", "docs.google.com"]
  },
};

document.addEventListener("DOMContentLoaded", async () => {
  // Get UI elements
  const themeMode = document.getElementById('themeMode');
  const customColors = document.getElementById('customColors');
  const bgColor = document.getElementById('bgColor');
  const accentColor = document.getElementById('accentColor');
  const textColor = document.getElementById('textColor');
  const fontStyle = document.getElementById('fontStyle');
  const categoryList = document.querySelector('.category-list');
  const addCategory = document.getElementById('addCategory');
  const save = document.getElementById('save');
  const reset = document.getElementById('reset');
  const msg = document.getElementById('msg');

  // Load current settings
  const settings = await chrome.storage.sync.get(DEFAULT_SETTINGS);
  
  // Apply theme settings to UI
  themeMode.value = settings.theme.mode;
  bgColor.value = settings.theme.custom.bgColor;
  accentColor.value = settings.theme.custom.accentColor;
  textColor.value = settings.theme.custom.textColor;
  fontStyle.value = settings.theme.fontStyle;
  customColors.style.display = settings.theme.mode === 'custom' ? 'block' : 'none';

  // Theme mode changes
  themeMode.addEventListener('change', () => {
    customColors.style.display = themeMode.value === 'custom' ? 'block' : 'none';
    applyTheme();
  });

  // Apply theme changes in real-time
  [bgColor, accentColor, textColor, fontStyle].forEach(el => {
    el.addEventListener('change', applyTheme);
  });

  // Category Management
  function createCategoryElement(name = '', domains = []) {
    const template = document.getElementById('category-template');
    const element = template.content.cloneNode(true);
    const container = element.querySelector('.category-item');
    const nameInput = element.querySelector('.category-name');
    const domainList = element.querySelector('.domain-list');
    const deleteBtn = element.querySelector('.delete-category');

    nameInput.value = name;
    domainList.value = domains.join('\n');

    deleteBtn.addEventListener('click', () => {
      if (confirm('Delete this category?')) {
        container.remove();
      }
    });

    return element;
  }

  // Add existing categories
  Object.entries(settings.categoryMap).forEach(([name, domains]) => {
    categoryList.appendChild(createCategoryElement(name, domains));
  });

  // Add new category button
  addCategory.addEventListener('click', () => {
    categoryList.appendChild(createCategoryElement());
  });


  // Save all settings
  save.addEventListener('click', async () => {
    try {
      // Collect categories
      const categoryMap = {};
      categoryList.querySelectorAll('.category-item').forEach(item => {
        const name = item.querySelector('.category-name').value.trim();
        const domains = item.querySelector('.domain-list')
          .value.split('\n')
          .map(d => d.trim())
          .filter(d => d);
        if (name && domains.length > 0) {
          categoryMap[name] = domains;
        }
      });

      // Build settings object
      const newSettings = {
        theme: {
          mode: themeMode.value,
          custom: {
            bgColor: bgColor.value,
            accentColor: accentColor.value,
            textColor: textColor.value
          },
          fontStyle: fontStyle.value
        },
      };

      // Save to storage (include categoryMap)
      newSettings.categoryMap = categoryMap;
      await chrome.storage.sync.set(newSettings);
      
      // Update UI
      msg.innerText = "✅ Settings saved successfully!";
      msg.className = "message success";
      setTimeout(() => msg.innerText = "", 2500);

      // Broadcast theme change to all tabs
      chrome.tabs.query({}, (tabs) => {
        tabs.forEach(tab => {
          chrome.tabs.sendMessage(tab.id, {
            action: 'themeChanged',
            theme: newSettings.theme
          }, () => {
            if (chrome.runtime.lastError) return;
          });
        });
      });

    } catch (e) {
      msg.innerText = "❌ Error saving settings";
      msg.className = "message error";
    }
  });

  // Reset to defaults
  reset.addEventListener('click', async () => {
    if (confirm('Reset all settings to default values?')) {
      await chrome.storage.sync.set(DEFAULT_SETTINGS);
      location.reload();
    }
  });

  // Apply theme function
  function applyTheme() {
    const mode = themeMode.value;
    document.body.dataset.theme = mode;
    
    if (mode === 'custom') {
      document.documentElement.style.setProperty('--bg-color', bgColor.value);
      document.documentElement.style.setProperty('--accent-color', accentColor.value);
      document.documentElement.style.setProperty('--text-color', textColor.value);
    } else {
      document.documentElement.style.removeProperty('--bg-color');
      document.documentElement.style.removeProperty('--accent-color');
      document.documentElement.style.removeProperty('--text-color');
    }
    
    document.documentElement.style.setProperty('--font-family', fontStyle.value);
  }

  // Initial theme application
  applyTheme();
});
