# Avatar Assets

This folder contains pixel art avatars organized by avatar type.

## Folder Structure

```
avatars/
├── default/
│   ├── neutral.png
│   ├── happy.png
│   ├── sad.png
│   ├── surprised.png
│   └── thinking.png
├── character1/
├── character2/
└── ...
```

## Requirements for Avatar Images

- **Format**: PNG (transparent background recommended)
- **Size**: 512x512px (optimized for the canvas)
- **Style**: Pixel art / retro style
- **States**: Create images for each emotion: neutral, happy, sad, surprised, thinking

## How to Use

1. Place your pixel art images in a folder (e.g., `default/`)
2. Update the sprite loader in `app.js`:

```javascript
const spriteMap = {
  'neutral': new Image(),
  'happy': new Image(),
  // ... etc
};

spriteMap['neutral'].src = 'avatars/default/neutral.png';
spriteMap['happy'].src = 'avatars/default/happy.png';
// ... load all states

avatar.loadSprites(spriteMap);
```

## Tips

- Use consistent color palettes across states
- Test scaling with CSS `image-rendering: pixelated`
