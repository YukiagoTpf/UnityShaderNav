Shader "Integration/Consumer"
{
    Properties
    {
        [HDR] _Tint ("Tint", Color) = (1,1,1,1)
    }
    Fallback "Integration/Library"
    SubShader
    {
        Cull Back
        UsePass "Integration/Library/FORWARDLIT"
    }
}
