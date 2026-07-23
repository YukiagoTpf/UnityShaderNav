Shader "UnityShaderNav/CaptureProbe"
{
    Properties
    {
        _Color ("Color", Color) = (0.1, 0.7, 1.0, 1.0)
    }

    SubShader
    {
        Pass
        {
            Name "Forward"

            HLSLPROGRAM
            #pragma vertex vert
            #pragma fragment frag
            #pragma multi_compile _ CAPTURE_TINT

            float4 vert(float4 position : POSITION) : SV_POSITION
            {
                return position;
            }

            float4 frag() : SV_Target
            {
                #if CAPTURE_TINT
                    return float4(1.0, 0.2, 0.1, 1.0);
                #else
                    return float4(0.1, 0.7, 1.0, 1.0);
                #endif
            }
            ENDHLSL
        }
    }
}
