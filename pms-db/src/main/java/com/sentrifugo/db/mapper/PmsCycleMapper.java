package com.sentrifugo.db.mapper;

import com.sentrifugo.db.dto.PmsCycleDTO;
import com.sentrifugo.db.entity.PmsCycleEntity;
import org.mapstruct.Builder;
import org.mapstruct.Mapper;
import org.mapstruct.MappingTarget;
import org.mapstruct.NullValuePropertyMappingStrategy;
import org.mapstruct.ReportingPolicy;

import java.util.List;

@Mapper(
        componentModel = "spring",
        unmappedTargetPolicy = ReportingPolicy.IGNORE,
        nullValuePropertyMappingStrategy = NullValuePropertyMappingStrategy.IGNORE,
        // Entity/DTO use Lombok @SuperBuilder; MapStruct's use of those wildcard builders generates a class that
        // fails to load at runtime (NoClassDefFoundError), so map through the no-arg constructor + setters.
        builder = @Builder(disableBuilder = true)
)
public interface PmsCycleMapper {

    PmsCycleEntity toEntity(PmsCycleDTO cycleDTO);

    PmsCycleDTO toDTO(PmsCycleEntity cycleEntity);

    List<PmsCycleEntity> toEntityList(
            List<PmsCycleDTO> cycleDTOList
    );

    List<PmsCycleDTO> toDTOList(
            List<PmsCycleEntity> cycleEntityList
    );

    void updateEntityFromDto(
            PmsCycleDTO dto,
            @MappingTarget PmsCycleEntity entity
    );
}