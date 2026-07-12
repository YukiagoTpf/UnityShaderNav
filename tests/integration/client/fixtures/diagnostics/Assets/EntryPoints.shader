Shader "Integration/Diagnostics"
{
    SubShader
    {
        Pass
        {
            HLSLPROGRAM
            #include "Included.hlsl"
            #pragma vertex MissingVertex
            #pragma fragment IncludedFragment
            ENDHLSL
        }
    }
}
