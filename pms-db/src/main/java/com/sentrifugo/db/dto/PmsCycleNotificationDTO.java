package com.sentrifugo.db.dto;

import com.sentrifugo.db.enums.PmsNotificationAudience;
import com.sentrifugo.db.enums.PmsNotificationStatus;
import lombok.AllArgsConstructor;
import lombok.Data;
import lombok.EqualsAndHashCode;
import lombok.NoArgsConstructor;
import lombok.experimental.SuperBuilder;

import java.time.LocalDateTime;
import java.util.UUID;

@Data
@SuperBuilder
@NoArgsConstructor
@AllArgsConstructor
@EqualsAndHashCode(callSuper = true)
public class PmsCycleNotificationDTO extends BaseDTO {

    private UUID id;

    private PmsNotificationAudience audience;

    private Integer sentCount;

    private PmsNotificationStatus status;

    private LocalDateTime sentOn;

    private String errorMessage;

    private UUID cycleId;
}
