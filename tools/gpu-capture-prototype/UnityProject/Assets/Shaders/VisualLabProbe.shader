Shader "UnityShaderNav/VisualLabProbe"
{
    Properties
    {
        _PreviewTint ("Preview Tint", Color) = (0.08, 0.42, 0.85, 1.0)
    }

    SubShader
    {
        Pass
        {
            Name "VisualLabForward"

            HLSLPROGRAM
            #pragma target 4.5
            #pragma vertex vert
            #pragma fragment frag

            float4 _PreviewTint;

            struct Attributes
            {
                float3 positionOS : POSITION;
            };

            struct Varyings
            {
                float4 positionCS : SV_POSITION;
            };

            Varyings vert(Attributes input)
            {
                Varyings output;
                output.positionCS = float4(input.positionOS.xy, 0.0, 1.0);
                return output;
            }

            float4 frag(Varyings input) : SV_Target
            {
                uint2 pixel = (uint2)floor(input.positionCS.xy);
                if (pixel.y < 8 && pixel.x < 8)
                {
                    return float4(asfloat(0x7fc00000), 0.0, 0.0, 1.0);
                }
                if (pixel.y < 8 && pixel.x < 16)
                {
                    return float4(asfloat(0x7f800000), 0.0, 0.0, 1.0);
                }
                return _PreviewTint;
            }
            ENDHLSL
        }
    }
}
